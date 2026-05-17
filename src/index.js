// prus-api2 - Smart Cache Worker with Diagnostics
// Combines data from statusm.me (4 types) + prus-api1 (luxury properties)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    
    // DIAGNOSTIC: Log every request
    console.log(`[${requestId}] [REQUEST] ${request.method} ${url.pathname}`);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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
    // ENDPOINT 4: Force refresh (admin only)
    // ============================================
    if (url.pathname === '/api/cache/refresh' && request.method === 'POST') {
      console.log(`[${requestId}] [ENDPOINT] /api/cache/refresh`);
      try {
        const auth = request.headers.get('X-Admin-Key');
        const expectedKey = env.ADMIN_KEY || 'your-secret-key';
        
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
        console.error(`[${requestId}] [ERROR] /api/cache/refresh:`, error);
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
        // DIAGNOSTIC: Check KV binding
        console.log(`[${requestId}] [DIAG] Checking KV binding...`);
        console.log(`[${requestId}] [DIAG] env.KV_BINDING exists: ${typeof env.KV_BINDING !== 'undefined'}`);
        
        let kvTestResult = 'not tested';
        if (env.KV_BINDING) {
          try {
            // Try to write a test value
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
        
        // Get all cache keys info
        const cacheKeysInfo = {};
        for (const [keyName, keyValue] of Object.entries(CACHE_KEYS)) {
          try {
            const data = await env.KV_BINDING.get(keyValue, 'json');
            cacheKeysInfo[keyName] = data ? `exists (${data.data?.length || data.count || 'unknown'} items)` : 'empty';
          } catch (e) {
            cacheKeysInfo[keyName] = `error: ${e.message}`;
          }
        }
        
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

    console.log(`[${requestId}] [404] Not found: ${url.pathname}`);
    return new Response(JSON.stringify({ 
      error: 'Not found',
      endpoints: [
        'GET /api/properties?luxury=true|false',
        'GET /api/cache/status',
        'POST /api/cache/update',
        'POST /api/cache/refresh (admin)',
        'GET /api/health'
      ]
    }), { status: 404, headers: corsHeaders });
  },
};

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
  
  // Get all cache entries in parallel
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
  const cacheTTL = (parseInt(env.CACHE_TTL_HOURS) || 1) * 60 * 60 * 1000;
  
  console.log(`[${requestId}] [getCacheStatus] Status from KV: ${status ? 'exists' : 'empty'}`);
  console.log(`[${requestId}] [getCacheStatus] cacheTTL: ${cacheTTL}ms (${cacheTTL / 3600000} hours)`);
  
  if (!status) {
    console.log(`[${requestId}] [getCacheStatus] No cache status found`);
    return {
      isFresh: false,
      lastUpdated: null,
      nextUpdateAfter: null,
      cacheTTLHours: cacheTTL / (60 * 60 * 1000),
      message: 'Cache is empty. Need initial scrape.'
    };
  }
  
  const age = now - status.lastUpdated;
  const isFresh = age < cacheTTL;
  
  console.log(`[${requestId}] [getCacheStatus] Last updated: ${new Date(status.lastUpdated).toISOString()}, age: ${Math.floor(age / 60000)} minutes, isFresh: ${isFresh}`);
  
  return {
    isFresh: isFresh,
    lastUpdated: new Date(status.lastUpdated).toISOString(),
    lastUpdatedTimestamp: status.lastUpdated,
    ageMinutes: Math.floor(age / 60000),
    nextUpdateAfter: new Date(status.lastUpdated + cacheTTL).toISOString(),
    cacheTTLHours: cacheTTL / (60 * 60 * 1000),
    message: isFresh ? 'Cache is fresh' : 'Cache expired - needs update'
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