// Worker B: Minute-by-minute instructions sync
export default {
  async fetch(request, env, ctx) {
    // Helper to get Finland time in ISO format
    function getFinlandTimeISO() {
      const now = new Date();
      return new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Helsinki' })).toISOString();
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
      // Find one recipe missing instructions
      const row = await env.DB.prepare(
        'SELECT recipe_guid, title FROM recipes WHERE instructions IS NULL LIMIT 1'
      ).first();
      if (!row) {
        // Don't log empty attempts
        return new Response('No recipes need instructions', { status: 200 });
      }
      if (!row.recipe_guid || !row.title) {
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          0,
          'missing_fields',
          'Row missing recipe_guid or title',
          'SELECT recipe_guid, title FROM recipes WHERE instructions IS NULL LIMIT 1 (missing fields)'
        ).run();
        return new Response('Row missing recipe_guid or title', { status: 200 });
      }
      // Authenticate
      const email = env.API_EMAIL;
      const password = env.API_PASSWORD;
      const apiKey = env.API_KEY;
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
      // Fetch instructions JSON
      const instructionsUrl = `https://api.ruokaboksi.fi/api/recipes/FIN/${row.recipe_guid}/instructions?country=FI&language=fi`;
      const detailRes = await fetch(instructionsUrl, {
        headers: { 'Authorization': `Bearer ${bearer}` }
      });
      if (!detailRes.ok) {
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          0,
          'fetch_failed',
          `Status: ${detailRes.status}`,
          `GET /recipes/FIN/${row.recipe_guid}/instructions (fetching instructions)`
        ).run();
        return new Response('Instructions fetch failed', { status: 500 });
      }
      const instructionsJson = await detailRes.json();
      if (!instructionsJson) {
        await env.DB.prepare(
          'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
        ).bind(
          getFinlandTimeISO(),
          0,
          'json_error',
          'Instructions JSON is undefined',
          `GET /recipes/FIN/${row.recipe_guid}/instructions (instructions JSON undefined)`
        ).run();
        return new Response('Instructions JSON is undefined', { status: 500 });
      }
      // Update row
      let instructionsToSave = instructionsJson;
      if (typeof instructionsJson === 'object') {
        instructionsToSave = JSON.stringify(instructionsJson);
      }
      await env.DB.prepare(
        'UPDATE recipes SET instructions = ? WHERE recipe_guid = ?'
      ).bind(instructionsToSave, row.recipe_guid).run();
      await env.DB.prepare(
        'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
      ).bind(
        getFinlandTimeISO(),
        1,
        'success',
        null,
        `Updated instructions for recipe ${row.title} (${row.recipe_guid})`
      ).run();
      return new Response(`Updated instructions for ${row.title}`, { status: 200 });
    } catch (err) {
      await env.DB.prepare(
        'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)' 
      ).bind(
        getFinlandTimeISO(),
        0,
        'exception',
        err.message,
        'Worker exception in recipe_sync_instructions'
      ).run();
      return new Response('Worker exception: ' + err.message, { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    // Call the same logic as fetch, but without request
    return await this.fetch(new Request('https://scheduled/'), env, ctx);
  }
}
