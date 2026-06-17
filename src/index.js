// prus-api2 - Smart Cache Worker with Diagnostics
// Combines data from statusm.me (4 types) + prus-api1 (luxury properties)

// ============================================
// KV USAGE TRACKING
// ============================================

// Track KV writes per day using a separate KV key
const KV_USAGE_KEY = 'kv_usage';

async function getKVUsage(env) {
  try {
    const usageData = await env.KV_BINDING.get(KV_USAGE_KEY, 'json');
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (!usageData) {
      return { date: today, count: 0, dailyLimit: 1000 };
    }

    // Reset if it's a new day
    if (usageData.date !== today) {
      // Reset counter for new day
      const resetData = { date: today, count: 0, dailyLimit: 1000 };
      await env.KV_BINDING.put(KV_USAGE_KEY, JSON.stringify(resetData));
      return resetData;
    }

    return {
      date: usageData.date,
      count: usageData.count || 0,
      dailyLimit: 1000,
      remaining: 1000 - (usageData.count || 0),
      resetAt: new Date(new Date().toISOString().split('T')[0] + 'T00:00:00.000Z').toISOString()
    };
  } catch (error) {
    console.error('Failed to get KV usage:', error);
    return { date: new Date().toISOString().split('T')[0], count: 0, dailyLimit: 1000, error: error.message };
  }
}

async function incrementKVUsage(env, count = 1) {
  try {
    const usageData = await getKVUsage(env);
    const today = new Date().toISOString().split('T')[0];

    // Reset if new day
    if (usageData.date !== today) {
      const resetData = { date: today, count: count, dailyLimit: 1000 };
      await env.KV_BINDING.put(KV_USAGE_KEY, JSON.stringify(resetData));
      return resetData;
    }

    const newCount = (usageData.count || 0) + count;
    const updated = {
      date: today,
      count: newCount,
      dailyLimit: 1000,
      remaining: 1000 - newCount,
      resetAt: new Date(new Date().toISOString().split('T')[0] + 'T00:00:00.000Z').toISOString()
    };
    await env.KV_BINDING.put(KV_USAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.error('Failed to increment KV usage:', error);
    return null;
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const startTime = Date.now();
    const requestId = crypto.randomUUID().slice(0, 8);

    const origin = request.headers.get('Origin');
    const host = request.headers.get('Host');

    // Allowed origins (browser requests)
    const ALLOWED_ORIGINS = [
      'https://admin.imbcargo-montenegro.com',
      'http://localhost:4200',
      'http://localhost:8787',
      'http://127.0.0.1:4200',
      'http://127.0.0.1:8787',
      'http://127.0.0.1:5500',
      'http://localhost:5500',
    ];

    // For local development - allow requests from localhost
    const isLocalRequest = host?.includes('localhost') ||
      host?.includes('127.0.0.1') ||
      host === 'localhost:8787' ||
      host === '127.0.0.1:8787' ||
      host === 'localhost:4200' ||
      host === 'localhost:5500' ||
      host === '127.0.0.1:5500' ||
      host === '127.0.0.1:4200';

    // Check if origin is allowed OR it's a local request
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin) || isLocalRequest || origin === null;

    // Log all requests
    console.log(`[${requestId}] [CORS] Origin: ${origin}, Host: ${host}, isLocal: ${isLocalRequest}, Allowed: ${isAllowedOrigin}`);

    // Block requests from unauthorized origins (for non-OPTIONS requests)
    if (!isAllowedOrigin && !isLocalRequest && origin !== null) {
      console.log(`[${requestId}] [CORS] BLOCKED - Origin not allowed: ${origin}`);
      return new Response(JSON.stringify({
        error: 'Unauthorized',
        message: 'Access from this origin is not allowed'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Dynamic CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': isAllowedOrigin && origin ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-API-Key',
      'Content-Type': 'application/json',
    };
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    console.log(`[${requestId}] [REQUEST] ${request.method} ${url.pathname}`);

    // ============================================
    // TEMPORARY DEBUG ENDPOINT
    // ============================================

    if (url.pathname === '/api/debug/key' && request.method === 'GET') {
      const auth = request.headers.get('X-Admin-Key');
      const storedKey = env.ADMIN_KEY;

      if (auth !== storedKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: corsHeaders });
      }

      return new Response(JSON.stringify({
        storedKeyLength: storedKey?.length || 0,
        storedKeyPrefix: storedKey?.substring(0, 10) + '...',
        yourKeyLength: auth?.length || 0,
        yourKeyPrefix: auth?.substring(0, 10) + '...',
        exactMatch: auth === storedKey
      }), { headers: corsHeaders });
    }

    // ============================================
    // ENDPOINT 1: Get all properties (from cache)
    // ============================================
    if (url.pathname === '/api/properties') {
      console.log(`[${requestId}] [ENDPOINT] /api/properties`);
      try {
        const includeLuxury = url.searchParams.get('luxury') !== 'false';
        console.log(`[${requestId}] [PARAMS] includeLuxury: ${includeLuxury}`);

        const result = await getAllCachedProperties(env, includeLuxury, requestId);

        console.log(`[${requestId}] [RESULT] Found ${result.properties.length} properties`);

        return new Response(JSON.stringify({
          source: 'cache',
          total: result.properties.length,
          properties: result.properties,
          cacheStatus: result.cacheStatus,
          timestamp: new Date().toISOString(),
        }, null, 2), { headers: corsHeaders });
      } catch (error) {
        console.error(`[${requestId}] [ERROR] /api/properties:`, error);
        return new Response(JSON.stringify({ error: error.message, stack: error.stack }),
          { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 2: Check if cache is fresh
    // ============================================
    if (url.pathname === '/api/cache/status') {
      console.log(`[${requestId}] [ENDPOINT] /api/cache/status`);
      try {
        const status = await getCacheStatus(env, requestId);
        console.log(`[${requestId}] [RESULT] isFresh: ${status.isFresh}, message: ${status.message}`);
        return new Response(JSON.stringify(status, null, 2), { headers: corsHeaders });
      } catch (error) {
        console.error(`[${requestId}] [ERROR] /api/cache/status:`, error);
        return new Response(JSON.stringify({ error: error.message, stack: error.stack }),
          { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 3: Update cache (called by frontend after scraping)
    // ============================================
    if (url.pathname === '/api/cache/update' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/cache/update`);
      try {
        const updateData = await request.json();
        console.log(`[${requestId}] [UPDATE] Type: ${updateData.type}, Properties: ${updateData.properties?.length}`);

        const result = await updateCache(env, updateData, requestId);

        console.log(`[${requestId}] [RESULT] Success: ${result.success}`);
        return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
      } catch (error) {
        console.error(`[${requestId}] [ERROR] /api/cache/update:`, error);
        return new Response(JSON.stringify({ error: error.message, stack: error.stack }),
          { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 4: Force delete (admin only)
    // ============================================
    if (url.pathname === '/api/cache/delete' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/cache/delete`);
      try {
        const auth = request.headers.get('X-Admin-Key');
        const expectedKey = env.ADMIN_KEY

        console.log(`[${requestId}] [AUTH] Provided: ${auth?.substring(0, 8)}..., Expected: ${expectedKey?.substring(0, 8)}...`);

        if (auth !== expectedKey) {
          console.log(`[${requestId}] [AUTH] Unauthorized`);
          return new Response(JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: corsHeaders });
        }

        await clearAllCache(env, requestId);
        console.log(`[${requestId}] [RESULT] Cache cleared`);

        return new Response(JSON.stringify({
          success: true,
          message: 'Cache cleared. Next request will trigger fresh scrape.'
        }), { headers: corsHeaders });
      } catch (error) {
        console.error(`[${requestId}] [ERROR] /api/cache/delete`, error);
        return new Response(JSON.stringify({ error: error.message }),
          { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 5: Health check with diagnostics
    // ============================================
    if (url.pathname === '/api/health') {
      console.log(`[${requestId}] [ENDPOINT] /api/health`);
      try {
        console.log(`[${requestId}] [DIAG] Checking KV binding...`);
        console.log(`[${requestId}] [DIAG] env.KV_BINDING exists: ${typeof env.KV_BINDING !== 'undefined'}`);

        let kvTestResult = 'not tested';
        if (env.KV_BINDING) {
          try {
            await env.KV_BINDING.put('_test_key', 'test_value');
            const testValue = await env.KV_BINDING.get('_test_key');
            await env.KV_BINDING.delete('_test_key');
            kvTestResult = `KV working! Read test value: ${testValue}`;
            console.log(`[${requestId}] [DIAG] ${kvTestResult}`);
          } catch (kvError) {
            kvTestResult = `KV error: ${kvError.message}`;
            console.error(`[${requestId}] [DIAG] ${kvTestResult}`);
          }
        }

        const status = await getCacheStatus(env, requestId);
        const usage = await getKVUsage(env);

        const cacheKeysInfo = {};
        for (const [keyName, keyValue] of Object.entries(CACHE_KEYS)) {
          try {
            const data = await env.KV_BINDING.get(keyValue, 'json');
            cacheKeysInfo[keyName] = data ? `exists (${data.data?.length || data.count || 'unknown'} items)` : 'empty';
          } catch (e) {
            cacheKeysInfo[keyName] = `error: ${e.message}`;
          }
        }

        // Calculate reset time based on UTC
        const now = new Date();
        const resetUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
        const hoursUntilReset = Math.round((resetUTC - now) / (1000 * 60 * 60));

        return new Response(JSON.stringify({
          status: 'healthy',
          diagnostics: {
            kvBindingExists: typeof env.KV_BINDING !== 'undefined',
            kvBindingTest: kvTestResult,
            envVars: {
              CACHE_TTL_HOURS: env.CACHE_TTL_HOURS || 'not set',
              ADMIN_KEY: env.ADMIN_KEY ? '***set***' : 'not set',
            },
            cacheKeys: cacheKeysInfo,
          },
          cacheStats: status,
          kvUsage: {
            ...usage,
            resetAt: resetUTC.toISOString(),
            hoursUntilReset: hoursUntilReset,
            remaining: Math.max(0, 1000 - (usage.count || 0)),
            isLimitReached: (usage.count || 0) >= 1000
          },
          config: {
            cacheTTLHours: parseInt(env.CACHE_TTL_HOURS || '1')
          },
          timestamp: new Date().toISOString(),
          requestId: requestId,
        }, null, 2), { headers: corsHeaders });
      } catch (error) {
        console.error(`[${requestId}] [ERROR] /api/health:`, error);
        return new Response(JSON.stringify({
          status: 'error',
          error: error.message,
          stack: error.stack
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 6: Extend cache TTL (admin only)
    // ============================================
    if (url.pathname === '/api/cache/extend' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/cache/extend`);

      const auth = request.headers.get('X-Admin-Key');
      const expectedKey = env.ADMIN_KEY;

      if (!expectedKey) {
        console.error(`[${requestId}] [AUTH] ADMIN_KEY not configured`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Server configuration error - ADMIN_KEY not set'
        }), { status: 500, headers: corsHeaders });
      }

      if (!auth || auth !== expectedKey) {
        console.log(`[${requestId}] [AUTH] Unauthorized - key mismatch`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Unauthorized - Invalid X-Admin-Key'
        }), { status: 401, headers: corsHeaders });
      }

      try {
        const body = await request.json();
        const existing = await env.KV_BINDING.get(CACHE_KEYS.STATUS, 'json');
        const now = Date.now();

        if (!existing) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No cache exists to extend'
          }), { status: 404, headers: corsHeaders });
        }

        const requestedHours = body?.extendHours;
        const ttlHours = requestedHours ? parseInt(requestedHours) : (parseInt(env.CACHE_TTL_HOURS) || 24);

        console.log(`[${requestId}] [EXTEND] Requested hours: ${requestedHours}, Using: ${ttlHours}`);

        const newExpiry = now + (ttlHours * 60 * 60 * 1000);

        const updatedStatus = {
          ...existing,
          lastUpdated: now,
          lastUpdatedISO: new Date(now).toISOString(),
          extendedAt: now,
          extendedBy: request.headers.get('CF-Connecting-IP') || 'admin',
          previousLastUpdated: existing.lastUpdated,
          expiresAt: newExpiry,
          ttlHours: ttlHours
        };

        await env.KV_BINDING.put(CACHE_KEYS.STATUS, JSON.stringify(updatedStatus));

        console.log(`[${requestId}] [EXTEND] Cache extended by ${ttlHours} hours`);

        return new Response(JSON.stringify({
          success: true,
          message: `Cache TTL extended by ${ttlHours} hours`,
          requestedHours: requestedHours || null,
          appliedHours: ttlHours,
          previousLastUpdated: new Date(existing.lastUpdated).toISOString(),
          newLastUpdated: new Date(now).toISOString(),
          expiresAt: new Date(newExpiry).toISOString()
        }), { headers: corsHeaders });

      } catch (error) {
        console.error(`[${requestId}] [EXTEND] Error:`, error);
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // NEW ENDPOINT 7: Restore full data.json (admin only)
    // Calls existing updateCache function 5 times
    // ============================================
    if (url.pathname === '/api/restore' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/restore`);

      const auth = request.headers.get('X-Admin-Key');
      const expectedKey = env.ADMIN_KEY;

      if (!expectedKey) {
        console.error(`[${requestId}] [AUTH] ADMIN_KEY not configured`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Server configuration error - ADMIN_KEY not set'
        }), { status: 500, headers: corsHeaders });
      }

      if (!auth || auth !== expectedKey) {
        console.log(`[${requestId}] [AUTH] Unauthorized - key mismatch`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Unauthorized - Invalid X-Admin-Key'
        }), { status: 401, headers: corsHeaders });
      }

      try {
        const data = await request.json();

        // Validate input has properties array
        if (!data.properties || !Array.isArray(data.properties)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Invalid format. Expected { properties: [] }'
          }), { status: 400, headers: corsHeaders });
        }

        console.log(`[${requestId}] [RESTORE] Received ${data.properties.length} properties`);

        // Split properties by type
        const flats = data.properties.filter(p => p.type === 'flats');
        const houses = data.properties.filter(p => p.type === 'houses');
        const plots = data.properties.filter(p => p.type === 'plots');
        const commercial = data.properties.filter(p => p.type === 'commercial');
        const luxury = data.properties.filter(p => ['apartment', 'penthouse', 'townhouse', 'villa'].includes(p.type));

        console.log(`[${requestId}] [RESTORE] Split: flats=${flats.length}, houses=${houses.length}, plots=${plots.length}, commercial=${commercial.length}, luxury=${luxury.length}`);

        // Call existing updateCache function 5 times
        const results = [];

        if (flats.length > 0) {
          const result = await updateCache(env, { type: 'flats', properties: flats }, requestId);
          results.push(result);
        }

        if (houses.length > 0) {
          const result = await updateCache(env, { type: 'houses', properties: houses }, requestId);
          results.push(result);
        }

        if (plots.length > 0) {
          const result = await updateCache(env, { type: 'plots', properties: plots }, requestId);
          results.push(result);
        }

        if (commercial.length > 0) {
          const result = await updateCache(env, { type: 'commercial', properties: commercial }, requestId);
          results.push(result);
        }

        if (luxury.length > 0) {
          const result = await updateCache(env, { type: 'luxury', properties: luxury }, requestId);
          results.push(result);
        }

        console.log(`[${requestId}] [RESTORE] Complete. ${results.length} types restored`);

        return new Response(JSON.stringify({
          success: true,
          message: 'Restore completed',
          results: results,
          totalProperties: data.properties.length
        }, null, 2), { headers: corsHeaders });

      } catch (error) {
        console.error(`[${requestId}] [RESTORE] Error:`, error);
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 8: Update property details (allImages, descriptions)
    // ============================================
    if (url.pathname === '/api/properties/update-details' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/properties/update-details`);

      try {
        const auth = request.headers.get('X-API-Key');
        const expectedKey = env.ADMIN_KEY;

        if (!expectedKey || auth !== expectedKey) {
          console.log(`[${requestId}] [AUTH] Unauthorized`);
          return new Response(JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: corsHeaders });
        }

        const detailData = await request.json();
        const { propertyId, allImages, description_ru, description_en, features, size, bedrooms, bathrooms, floor } = detailData;

        console.log(`[${requestId}] [DETAIL] Updating property ${propertyId} with ${allImages?.length || 0} images`);

        // Find which type contains this property and update it
        const types = ['flats', 'houses', 'plots', 'commercial', 'luxury'];
        let updated = false;

        for (const type of types) {
          const cacheKey = `cache_${type}`;
          const cached = await env.KV_BINDING.get(cacheKey, 'json');

          if (cached && cached.data) {
            const propertyIndex = cached.data.findIndex(p => p.id === propertyId);

            if (propertyIndex !== -1) {
              // Update the property with details
              cached.data[propertyIndex] = {
                ...cached.data[propertyIndex],
                allImages: allImages || cached.data[propertyIndex].allImages || [],
                description_ru: description_ru || cached.data[propertyIndex].description_ru,
                description_en: description_en || cached.data[propertyIndex].description_en,
                features: features || cached.data[propertyIndex].features || [],
                size: size || cached.data[propertyIndex].size,
                bedrooms: bedrooms || cached.data[propertyIndex].bedrooms,
                bathrooms: bathrooms || cached.data[propertyIndex].bathrooms,
                floor: floor || cached.data[propertyIndex].floor,
                detailsUpdatedAt: new Date().toISOString()
              };

              // Save back to KV
              await env.KV_BINDING.put(cacheKey, JSON.stringify(cached));
              updated = true;
              console.log(`[${requestId}] [DETAIL] Updated property ${propertyId} in ${type}`);
              break;
            }
          }
        }

        if (updated) {
          // Also update the all-ids index
          const idsIndex = await env.KV_BINDING.get(CACHE_KEYS.ALL_IDS, 'json');
          if (idsIndex) {
            for (const type of types) {
              const key = `${type}_${propertyId}`;
              if (idsIndex[key]) {
                idsIndex[key] = {
                  ...idsIndex[key],
                  allImages: allImages,
                  description_ru: description_ru,
                  description_en: description_en,
                  features: features,
                  detailsUpdatedAt: new Date().toISOString()
                };
                await env.KV_BINDING.put(CACHE_KEYS.ALL_IDS, JSON.stringify(idsIndex));
                break;
              }
            }
          }

          return new Response(JSON.stringify({
            success: true,
            message: `Property ${propertyId} updated with details`,
            propertyId: propertyId
          }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({
            success: false,
            error: `Property ${propertyId} not found in any cache`
          }), { status: 404, headers: corsHeaders });
        }

      } catch (error) {
        console.error(`[${requestId}] [DETAIL] Error:`, error);
        return new Response(JSON.stringify({ error: error.message }),
          { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // ENDPOINT 9: Batch update property details
    // ============================================
    if (url.pathname === '/api/properties/batch-update-details' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/properties/batch-update-details`);

      try {
        const auth = request.headers.get('X-API-Key');
        const expectedKey = env.ADMIN_KEY;

        if (!expectedKey || auth !== expectedKey) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: corsHeaders });
        }

        const { updates } = await request.json();
        console.log(`[${requestId}] [BATCH] Updating ${updates.length} properties`);

        let successCount = 0;
        let failCount = 0;

        for (const update of updates) {
          // Call the helper function to reuse the update logic
          const updateResponse = await handlePropertyUpdate(env, update, requestId);
          if (updateResponse.success) {
            successCount++;
          } else {
            failCount++;
          }
        }

        return new Response(JSON.stringify({
          success: true,
          updated: successCount,
          failed: failCount,
          total: updates.length
        }), { headers: corsHeaders });

      } catch (error) {
        console.error(`[${requestId}] [BATCH] Error:`, error);
        return new Response(JSON.stringify({ error: error.message }),
          { status: 500, headers: corsHeaders });
      }
    }

    // ============================================
    // 404 handler - No other endpoints matched
    // ============================================
    console.log(`[${requestId}] [404] Not found: ${url.pathname}`);
    return new Response(JSON.stringify({
      error: 'Not found',
      endpoints: [
        'GET /api/properties?luxury=true|false',
        'GET /api/cache/status',
        'POST /api/cache/update',
        'POST /api/cache/delete (admin)',
        'POST /api/cache/extend (admin)',
        'GET /api/health',
        'POST /api/restore (admin) - Upload full data.json',
        'POST /api/properties/update-details (admin) - Update single property details',
        'POST /api/properties/batch-update-details (admin) - Batch update property details'
      ]
    }), { status: 404, headers: corsHeaders });
  },
};

// ============================================
// HELPER FUNCTIONS OUTSIDE the fetch handler
// ============================================

// Helper function for property update
async function handlePropertyUpdate(env, detailData, requestId) {
  const { propertyId, allImages, description_ru, description_en, features, size, bedrooms, bathrooms, floor } = detailData;
  const types = ['flats', 'houses', 'plots', 'commercial', 'luxury'];

  for (const type of types) {
    const cacheKey = `cache_${type}`;
    const cached = await env.KV_BINDING.get(cacheKey, 'json');

    if (cached && cached.data) {
      const propertyIndex = cached.data.findIndex(p => p.id === propertyId);

      if (propertyIndex !== -1) {
        cached.data[propertyIndex] = {
          ...cached.data[propertyIndex],
          allImages: allImages || cached.data[propertyIndex].allImages || [],
          description_ru: description_ru || cached.data[propertyIndex].description_ru,
          description_en: description_en || cached.data[propertyIndex].description_en,
          features: features || cached.data[propertyIndex].features || [],
          size: size || cached.data[propertyIndex].size,
          bedrooms: bedrooms || cached.data[propertyIndex].bedrooms,
          bathrooms: bathrooms || cached.data[propertyIndex].bathrooms,
          floor: floor || cached.data[propertyIndex].floor,
          detailsUpdatedAt: new Date().toISOString()
        };

        await env.KV_BINDING.put(cacheKey, JSON.stringify(cached));
        return { success: true, propertyId, type };
      }
    }
  }

  return { success: false, propertyId, error: 'Property not found' };
}

// ============================================
// CACHE KEYS
// ============================================
const CACHE_KEYS = {
  FLATS: 'cache_flats',
  HOUSES: 'cache_houses',
  PLOTS: 'cache_plots',
  COMMERCIAL: 'cache_commercial',
  LUXURY: 'cache_luxury',
  STATUS: 'cache_status',
  ALL_IDS: 'cache_all_ids'
};

// ============================================
// Get all cached properties
// ============================================
async function getAllCachedProperties(env, includeLuxury = true, requestId = 'unknown') {
  console.log(`[${requestId}] [getAllCachedProperties] Starting...`);
  console.log(`[${requestId}] [getAllCachedProperties] includeLuxury: ${includeLuxury}`);
  console.log(`[${requestId}] [getAllCachedProperties] env.KV_BINDING exists: ${!!env.KV_BINDING}`);

  const cacheStatus = await getCacheStatus(env, requestId);

  console.log(`[${requestId}] [getAllCachedProperties] Fetching cache keys: ${Object.values(CACHE_KEYS).join(', ')}`);

  const [flats, houses, plots, commercial, luxury] = await Promise.all([
    env.KV_BINDING.get(CACHE_KEYS.FLATS, 'json'),
    env.KV_BINDING.get(CACHE_KEYS.HOUSES, 'json'),
    env.KV_BINDING.get(CACHE_KEYS.PLOTS, 'json'),
    env.KV_BINDING.get(CACHE_KEYS.COMMERCIAL, 'json'),
    includeLuxury ? env.KV_BINDING.get(CACHE_KEYS.LUXURY, 'json') : null,
  ]);

  console.log(`[${requestId}] [getAllCachedProperties] Results - flats: ${flats?.data?.length || 0}, houses: ${houses?.data?.length || 0}, plots: ${plots?.data?.length || 0}, commercial: ${commercial?.data?.length || 0}, luxury: ${luxury?.data?.length || 0}`);

  let allProperties = [];

  if (flats?.data) allProperties.push(...flats.data);
  if (houses?.data) allProperties.push(...houses.data);
  if (plots?.data) allProperties.push(...plots.data);
  if (commercial?.data) allProperties.push(...commercial.data);

  if (includeLuxury && luxury?.data) {
    const luxuryProps = luxury.data.map(p => ({ ...p, source: 'luxury' }));
    allProperties.push(...luxuryProps);
  }

  console.log(`[${requestId}] [getAllCachedProperties] Total properties: ${allProperties.length}`);

  return {
    properties: allProperties,
    cacheStatus: cacheStatus,
    counts: {
      flats: flats?.data?.length || 0,
      houses: houses?.data?.length || 0,
      plots: plots?.data?.length || 0,
      commercial: commercial?.data?.length || 0,
      luxury: luxury?.data?.length || 0,
      total: allProperties.length
    }
  };
}

// ============================================
// Get cache status (when was it last updated?)
// ============================================
async function getCacheStatus(env, requestId = 'unknown') {
  console.log(`[${requestId}] [getCacheStatus] Starting...`);
  console.log(`[${requestId}] [getCacheStatus] env.KV_BINDING: ${typeof env.KV_BINDING}`);

  if (!env.KV_BINDING) {
    console.error(`[${requestId}] [getCacheStatus] KV_BINDING is undefined!`);
    return {
      isFresh: false,
      lastUpdated: null,
      error: 'KV_BINDING not available',
      message: 'KV binding missing - check wrangler.toml configuration'
    };
  }

  const status = await env.KV_BINDING.get(CACHE_KEYS.STATUS, 'json');
  const now = Date.now();

  console.log(`[${requestId}] [getCacheStatus] Status from KV: ${status ? 'exists' : 'empty'}`);

  if (!status) {
    console.log(`[${requestId}] [getCacheStatus] No cache status found`);
    const defaultTtl = 8760;
    return {
      isFresh: false,
      lastUpdated: null,
      nextUpdateAfter: null,
      cacheTTLHours: defaultTtl,
      ttlHours: defaultTtl,
      message: 'Cache is empty. Need initial scrape.'
    };
  }

  if (!status.lastUpdated || typeof status.lastUpdated !== 'number' || isNaN(status.lastUpdated)) {
    console.log(`[${requestId}] [getCacheStatus] Invalid lastUpdated value: ${status.lastUpdated}, using current time`);
    // Fix the status by setting current time with 1 year TTL
    const fixedStatus = {
      ...status,
      lastUpdated: now,
      lastUpdatedISO: new Date(now).toISOString(),
      ttlHours: status.ttlHours || 8760
    };
    await env.KV_BINDING.put(CACHE_KEYS.STATUS, JSON.stringify(fixedStatus));
    return {
      isFresh: true, // FIX: Mark as fresh after fix
      lastUpdated: new Date(now).toISOString(),
      lastUpdatedTimestamp: now,
      ageMinutes: 0,
      ttlHours: fixedStatus.ttlHours,
      message: 'Cache status was invalid, has been fixed and is now fresh'
    };
  }

  const effectiveTtlHours = status.ttlHours || parseInt(env.CACHE_TTL_HOURS) || 8760;
  const cacheTTL = effectiveTtlHours * 60 * 60 * 1000;
  const age = now - status.lastUpdated;
  const isFresh = age < cacheTTL;

  console.log(`[${requestId}] [getCacheStatus] cacheTTL: ${cacheTTL}ms (${cacheTTL / 3600000} hours)`);
  console.log(`[${requestId}] [getCacheStatus] Last updated: ${new Date(status.lastUpdated).toISOString()}, age: ${Math.floor(age / 60000)} minutes, isFresh: ${isFresh}`);
  console.log(`[${requestId}] [getCacheStatus] TTL hours: ${effectiveTtlHours}, Age hours: ${age / 3600000}`);

  return {
    isFresh: isFresh,
    lastUpdated: new Date(status.lastUpdated).toISOString(),
    lastUpdatedTimestamp: status.lastUpdated,
    ageMinutes: Math.floor(age / 60000),
    ttlHours: effectiveTtlHours,
    nextUpdateAfter: new Date(status.lastUpdated + cacheTTL).toISOString(),
    cacheTTLHours: effectiveTtlHours,
    message: isFresh ? `Cache is fresh (expires in ${Math.floor((cacheTTL - age) / 3600000)} hours)` : 'Cache expired - needs update'
  };
}

// ============================================
// Update cache (called by frontend after scraping)
// ============================================
async function updateCache(env, updateData, requestId = 'unknown') {
  const { type, properties, sourceIp, userAgent, timestamp } = updateData;

  console.log(`[${requestId}] [updateCache] Starting for type: ${type}`);
  console.log(`[${requestId}] [updateCache] Properties count: ${properties?.length || 0}`);
  console.log(`[${requestId}] [updateCache] Source IP: ${sourceIp}`);

  const validTypes = ['flats', 'houses', 'plots', 'commercial', 'luxury'];
  if (!validTypes.includes(type)) {
    console.log(`[${requestId}] [updateCache] Invalid type: ${type}`);
    return { success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` };
  }

  const cacheKey = `cache_${type}`;
  console.log(`[${requestId}] [updateCache] Cache key: ${cacheKey}`);

  await env.KV_BINDING.put(cacheKey, JSON.stringify({
    data: properties,
    count: properties?.length || 0,
    lastUpdated: timestamp || new Date().toISOString(),
    sourceIp: sourceIp,
    userAgent: userAgent
  }));

  console.log(`[${requestId}] [updateCache] Stored in KV`);

  await updateGlobalStatus(env, type, requestId);
  await updateAllIdsIndex(env, type, properties, requestId);

  console.log(`[${requestId}] [updateCache] Complete`);

  return {
    success: true,
    type: type,
    count: properties?.length || 0,
    storedAt: new Date().toISOString()
  };
}

// ============================================
// Update global status metadata
// ============================================
async function updateGlobalStatus(env, updatedType, requestId = 'unknown') {
  console.log(`[${requestId}] [updateGlobalStatus] Updating for type: ${updatedType}`);

  const existing = await env.KV_BINDING.get(CACHE_KEYS.STATUS, 'json');
  const now = Date.now();

  const newStatus = {
    lastUpdated: now,
    lastUpdatedISO: new Date(now).toISOString(),
    lastUpdatedType: updatedType,
    updatedTypes: {
      ...(existing?.updatedTypes || {}),
      [updatedType]: now
    }
  };

  await env.KV_BINDING.put(CACHE_KEYS.STATUS, JSON.stringify(newStatus));
  console.log(`[${requestId}] [updateGlobalStatus] Status updated`);
}

// ============================================
// Update all-ids index for fast lookups
// ============================================
async function updateAllIdsIndex(env, type, properties, requestId = 'unknown') {
  console.log(`[${requestId}] [updateAllIdsIndex] Updating index for ${properties?.length || 0} properties`);

  const existing = await env.KV_BINDING.get(CACHE_KEYS.ALL_IDS, 'json');
  const index = existing || {};
  const now = Date.now();

  let updatedCount = 0;
  for (const prop of properties) {
    if (prop.id) {
      index[`${type}_${prop.id}`] = {
        id: prop.id,
        type: type,
        title: prop.title,
        slug: prop.slug,
        url: prop.url,
        price: prop.price,
        location: prop.location,
        mainImage: prop.mainImage,
        source: type === 'luxury' ? 'luxury' : 'statusm',
        updatedAt: now
      };
      updatedCount++;
    }
  }

  await env.KV_BINDING.put(CACHE_KEYS.ALL_IDS, JSON.stringify(index));
  console.log(`[${requestId}] [updateAllIdsIndex] Index updated with ${updatedCount} properties`);
}

// ============================================
// Clear all cache
// ============================================
async function clearAllCache(env, requestId = 'unknown') {
  console.log(`[${requestId}] [clearAllCache] Clearing all cache keys...`);

  const keys = Object.values(CACHE_KEYS);
  for (const key of keys) {
    await env.KV_BINDING.delete(key);
    console.log(`[${requestId}] [clearAllCache] Deleted: ${key}`);
  }
  console.log(`[${requestId}] [clearAllCache] Cleared all ${keys.length} cache entries`);
}