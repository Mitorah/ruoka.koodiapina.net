// Worker A: Daily sync of recipe IDs and titles
export default {
  async fetch(request, env, ctx) {
    // Store real UTC; AdminLogs.vue already converts to Helsinki time for
    // display, so shifting it here too double-applies the DST offset.
    function getFinlandTimeISO() {
      return new Date().toISOString();
    }
    // Check required environment variables
    if (!env.API_EMAIL || !env.API_PASSWORD || !env.API_KEY) {
      await env.DB.prepare(
        'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        getFinlandTimeISO(),
        0,
        'env_error',
        'Missing one or more required environment variables (API_EMAIL, API_PASSWORD, API_KEY)',
        'Worker startup'
      ).run();
      return new Response('Missing required environment variables', { status: 500 });
    }
    try {
      const email = env.API_EMAIL;
      const password = env.API_PASSWORD;
      const apiKey = env.API_KEY;
      // Authenticate
      let tokenRes, tokenData, bearer;
      try {
        tokenRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true })
          }
        );
        if (!tokenRes.ok) {
          const errorBody = await tokenRes.text();
          await env.DB.prepare(
            'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)'
          ).bind(
            getFinlandTimeISO(),
            0,
            'auth_failed',
            `Status: ${tokenRes.status}`,
            `POST /accounts:signInWithPassword (authenticating) - ${errorBody}`
          ).run();
          return new Response(`Auth failed: ${errorBody}`, { status: 401 });
        }
        tokenData = await tokenRes.json();
        bearer = tokenData.idToken;
        if (!bearer) {
          await env.DB.prepare(
            'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
          ).bind(
            getFinlandTimeISO(),
            0,
            'auth_failed',
            'No idToken in response',
            'POST /accounts:signInWithPassword (authenticating)'
          ).run();
          return new Response('Auth failed: No idToken', { status: 401 });
        }
      } catch (err) {
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          0,
          'auth_exception',
          err.message,
          'POST /accounts:signInWithPassword (authenticating)'
        ).run();
        return new Response('Auth exception: ' + err.message, { status: 500 });
      }
      // Fetch recipe list
      const recipesRes = await fetch('https://api.ruokaboksi.fi/api/recipes/FIN?country=FI&language=fi', {
        headers: { 'Authorization': `Bearer ${bearer}` }
      });
      const debugText = await recipesRes.text();
      if (!recipesRes.ok) {
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          0,
          'fetch_failed',
          `Status: ${recipesRes.status}`,
          'GET /recipes (fetching recipe IDs and titles)'
        ).run();
        return new Response(`Recipe fetch failed. Status: ${recipesRes.status}. Response: ${debugText}`, { status: 500 });
      }
      let recipes;
      try {
        const parsed = JSON.parse(debugText);
        if (Array.isArray(parsed.items)) {
          recipes = parsed.items;
        } else {
          await env.DB.prepare(
            'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
          ).bind(
            getFinlandTimeISO(),
            0,
            'no_items',
            'No items array found',
            'GET /recipes (fetching recipe IDs and titles) - no items array found'
          ).run();
          return new Response('No items array found in API response', { status: 500 });
        }
      } catch (err) {
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          0,
          'json_error',
          err.message,
          'GET /recipes (fetching recipe IDs and titles) - JSON parse error'
        ).run();
        return new Response('Invalid recipes JSON', { status: 500 });
      }
      // Query existing recipe GUIDs from the database
      const existingRows = await env.DB.prepare('SELECT recipe_guid FROM recipes').all();
      const existingIds = new Set(existingRows.results.map(r => r.recipe_guid));
      // Filter only new recipes
      const newRecipes = recipes.filter(r => r.id && r.title && !existingIds.has(r.id));
      // Limit to 20 new recipes per invocation and batch insert
      const batch = newRecipes.slice(0, 20);
      if (batch.length > 0) {
        const now = getFinlandTimeISO();
        const values = batch.map(() => '(?, ?, ?, ?)').join(', ');
        const sql = `INSERT OR IGNORE INTO recipes (recipe_guid, title, added_date, details) VALUES ${values}`;
        const binds = batch.flatMap(r => {
          let detailsObj = {
            preparationTime: r.preparationTime,
            serves: r.serves,
            allergens: Array.isArray(r.allergens) ? r.allergens.map(a => ({ id: a.id, title: a.title })) : [],
            diets: Array.isArray(r.diets) ? r.diets.map(d => ({ id: d.id, title: d.title })) : []
          };
          let detailsToSave = detailsObj;
          if (typeof detailsObj === 'object') {
            detailsToSave = JSON.stringify(detailsObj);
          }
          return [
            r.id,
            r.title,
            now,
            detailsToSave
          ];
        });
        const result = await env.DB.prepare(sql).bind(...binds).run();
        var inserted = result.success ? batch.length : 0;
      } else {
        var inserted = 0;
      }
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          inserted,
          'success',
          null,
          `Inserted ${inserted} new recipes (batch size: ${batch.length})`
        ).run();
      return new Response(`Inserted ${inserted} new recipes`, { status: 200 });
    } catch (err) {
      await env.DB.prepare(
        'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
      ).bind(
        getFinlandTimeISO(),
        0,
        'exception',
        err.message,
        'Worker exception in recipe_sync_ids'
      ).run();
      return new Response('Worker exception: ' + err.message, { status: 500 });
    }
  },
    async scheduled(event, env, ctx) {
      // Call the same logic as fetch, but without request
      return await this.fetch(new Request('https://scheduled/'), env, ctx);
    }
}
