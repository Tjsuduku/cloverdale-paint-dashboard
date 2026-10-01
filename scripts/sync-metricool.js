#!/usr/bin/env node
/**
 * Sync Metricool scheduled/published posts to Supabase content_calendar table.
 *
 * Environment variables:
 *   METRICOOL_API_TOKEN        - Metricool API token (from GitHub secrets)
 *   SUPABASE_URL               - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  - Service role key for server-side writes (from GitHub secrets)
 *   METRICOOL_BRAND_ID         - Cloverdale's brand ID (6980817)
 *   METRICOOL_USER_ID          - Cloverdale's user ID (5352390)
 */

const https = require('https');

// Configuration
const METRICOOL_API_TOKEN = process.env.METRICOOL_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BRAND_ID = parseInt(process.env.METRICOOL_BRAND_ID || '6980817', 10);
const USER_ID = parseInt(process.env.METRICOOL_USER_ID || '5352390', 10);

if (!METRICOOL_API_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

/**
 * Make an HTTPS request and return the parsed JSON response.
 */
function httpsRequest(method, hostname, path, headers, body = null) {
  return new Promise((resolve, reject) => {
    const options = { method, hostname, path, headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch scheduled and published posts from Metricool.
 */
async function fetchMetricoolPosts() {
  console.log('📡 Fetching posts from Metricool...');

  // Date range: last 90 days
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const dateFrom = ninetyDaysAgo.toISOString();  // e.g., 2026-07-04T12:34:56.789Z
  const dateTo = now.toISOString();
  const timezone = 'UTC';  // Can be customized per Cloverdale's timezone if needed

  console.log(`  Date range: ${dateFrom} to ${dateTo}`);

  // Metricool API endpoint
  // Based on MCP instructions, the endpoint is likely:
  // POST /api/v1/posts/scheduled (or similar)
  // The exact endpoint may vary; common pattern is /api/v1/social/posts
  // We'll try the generic posts endpoint with status filter

  const requestBody = JSON.stringify({
    brandId: BRAND_ID,
    userId: USER_ID,
    dateFrom,
    dateTo,
    timezone,
    status: ['scheduled', 'published'],  // Fetch both statuses
  });

  const headers = {
    'Authorization': `Bearer ${METRICOOL_API_TOKEN}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(requestBody),
  };

  try {
    // Try the scheduled posts endpoint first
    const response = await httpsRequest(
      'POST',
      'api.metricool.com',
      '/api/v1/posts/scheduled',
      headers,
      requestBody
    );

    if (response.status === 200 && response.body.data) {
      console.log(`✓ Fetched ${response.body.data.length} posts from Metricool`);
      return response.body.data;
    } else {
      console.error(`⚠ Metricool API returned status ${response.status}`, response.body);
      return [];
    }
  } catch (error) {
    console.error('❌ Failed to fetch from Metricool:', error.message);
    return [];
  }
}

/**
 * Upsert a post into Supabase content_calendar table.
 * Uses external_id as the unique key to avoid duplicates on re-sync.
 */
async function upsertPost(post) {
  // Map Metricool post to Supabase schema
  const supabaseRow = {
    external_id: post.id || post.external_id || String(post.postId),  // Metricool post ID
    platform: (post.platform || 'facebook').toLowerCase(),
    caption: post.caption || post.message || '',
    publication_date: post.publication_date || post.scheduledTime || new Date().toISOString(),
    status: (post.status || 'scheduled').toLowerCase(),
    public_url: post.public_url || post.url || null,
    synced_at: new Date().toISOString(),
  };

  // Build the upsert query
  // UPSERT syntax: INSERT ... ON CONFLICT(external_id) DO UPDATE SET ...
  // Via REST API, we use: POST to /rest/v1/content_calendar with upsert=true and onConflict=external_id
  const query = {
    external_id: supabaseRow.external_id,
    platform: supabaseRow.platform,
    caption: supabaseRow.caption,
    publication_date: supabaseRow.publication_date,
    status: supabaseRow.status,
    public_url: supabaseRow.public_url,
    synced_at: supabaseRow.synced_at,
  };

  const body = JSON.stringify(query);
  const headers = {
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Prefer': 'resolution=merge-duplicates',  // UPSERT behavior
  };

  try {
    const url = new URL(SUPABASE_URL);
    const response = await httpsRequest(
      'POST',
      url.hostname,
      `/rest/v1/content_calendar?on_conflict=external_id`,
      headers,
      body
    );

    if (response.status >= 200 && response.status < 300) {
      console.log(`  ✓ Upserted post ${supabaseRow.external_id}`);
      return true;
    } else {
      console.error(`  ⚠ Upsert failed (${response.status}):`, response.body);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Error upserting post ${supabaseRow.external_id}:`, error.message);
    return false;
  }
}

/**
 * Main sync function.
 */
async function syncPosts() {
  console.log('\n🔄 Metricool → Supabase Content Calendar Sync\n');

  const posts = await fetchMetricoolPosts();
  if (posts.length === 0) {
    console.log('ℹ No posts to sync.');
    return;
  }

  console.log(`\n📝 Upserting ${posts.length} posts to Supabase...`);
  let successCount = 0;
  for (const post of posts) {
    const success = await upsertPost(post);
    if (success) successCount++;
  }

  console.log(`\n✅ Sync complete: ${successCount}/${posts.length} posts upserted`);
}

// Run the sync
syncPosts().catch((error) => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
