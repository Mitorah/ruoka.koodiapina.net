// Worker: Populate search_text for recipes (runs daily)
// Processes 100 recipes at a time, extracting and stemming ingredients/titles

export default {
  async scheduled(event, env, ctx) {
    // Store real UTC; AdminLogs.vue already converts to Helsinki time for
    // display, so shifting it here too double-applies the DST offset.
    function getFinlandTimeISO() {
      return new Date().toISOString();
    }

    const timestamp = getFinlandTimeISO();
    
    try {
      // Get 100 recipes that need search_text populated (NULL or oldest updates)
      const recipesToProcess = await env.DB.prepare(
        `SELECT recipe_guid, title, details 
         FROM recipes 
         WHERE search_text IS NULL 
         ORDER BY added_date DESC 
         LIMIT 100`
      ).all();

      if (!recipesToProcess.results || recipesToProcess.results.length === 0) {
        return;
      }

      let processed = 0;
      const errors = [];

      for (const recipe of recipesToProcess.results) {
        try {
          const searchText = extractSearchableText(recipe);
          
          await env.DB.prepare(
            'UPDATE recipes SET search_text = ? WHERE recipe_guid = ?'
          ).bind(searchText, recipe.recipe_guid).run();
          
          processed++;
        } catch (error) {
          errors.push({ recipe_guid: recipe.recipe_guid, error: error.message });
        }
      }

      await env.DB.prepare(
        'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        timestamp,
        processed,
        'success',
        errors.length > 0 ? `${errors.length} errors` : null,
        `Processed ${processed}/${recipesToProcess.results.length} recipes. Errors: ${JSON.stringify(errors)}`
      ).run();

    } catch (error) {
      await env.DB.prepare(
        'INSERT INTO fetch_log (timestamp, count, status, error, details) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        timestamp,
        0,
        'exception',
        error.message,
        'Worker exception in recipe_search_populate'
      ).run();
    }
  },

  // Allow manual triggering via HTTP
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Manual trigger endpoint
    if (url.pathname === '/populate' && request.method === 'POST') {
      // Run the scheduled logic manually
      await this.scheduled(null, env, ctx);
      return new Response('Search text population triggered', { status: 200 });
    }

    return new Response('Search Population Worker. Use POST /populate to trigger manually.', { 
      status: 200 
    });
  }
};

/**
 * Extract and normalize searchable text from recipe
 * @param {Object} recipe - Recipe object with title and details
 * @returns {string} - Normalized, stemmed, lowercase text for searching
 */
function extractSearchableText(recipe) {
  const words = new Set();

  // Add title words (cleaned and stemmed)
  const titleWords = extractWords(recipe.title);
  titleWords.forEach(word => {
    const stemmed = stemFinnish(word);
    if (stemmed) words.add(stemmed);
  });

  // Parse details JSON and extract ingredients
  try {
    const details = JSON.parse(recipe.details);
    
    if (details.ingredientLists && Array.isArray(details.ingredientLists)) {
      for (const list of details.ingredientLists) {
        if (list.ingredients && Array.isArray(list.ingredients)) {
          for (const ingredient of list.ingredients) {
            if (ingredient.title) {
              const ingredientWords = extractWords(ingredient.title);
              ingredientWords.forEach(word => {
                const stemmed = stemFinnish(word);
                if (stemmed) words.add(stemmed);
              });
            }
          }
        }
      }
    }
  } catch (error) {
    // Error parsing recipe details
  }

  return Array.from(words).join(' ');
}

/**
 * Extract meaningful words from text, removing measurements and numbers
 * @param {string} text - Input text (e.g., "1 kg perunoita")
 * @returns {Array<string>} - Cleaned words (e.g., ["perunoita"])
 */
function extractWords(text) {
  if (!text) return [];

  // Common Finnish measurement units and words to skip
  const skipWords = new Set([
    'kg', 'g', 'mg', 'l', 'dl', 'cl', 'ml', 'tl', 'rkl', 'ps', 'pkt', 'pala', 'pussi',
    'paketti', 'purkki', 'pullo', 'laatikko', 'rasia', 'kpl', 'ripaus', 'tilkka',
    'hyppysellinen', 'pss', 'prk', 'plo', 'ja', 'tai', 'sekä', 'että'
  ]);

  return text
    .toLowerCase()
    // Remove numbers and their decimal points
    .replace(/\d+([.,]\d+)?/g, ' ')
    // Remove special characters but keep Finnish letters
    .replace(/[^a-zåäö\s]/g, ' ')
    // Split into words
    .split(/\s+/)
    // Filter out empty strings and skip words
    .filter(word => word.length > 0 && !skipWords.has(word));
}

/**
 * Simple Finnish stemmer - removes common suffixes
 * This is a lightweight approach suitable for Cloudflare Workers
 * @param {string} word - Finnish word to stem
 * @returns {string} - Stemmed word
 */
function stemFinnish(word) {
  if (!word || word.length < 3) return word;

  // Store original for fallback
  const original = word;

  // Remove possessive suffixes (must be done first)
  word = word.replace(/(ni|si|nsa|mme|nne|nsa)$/, '');

  // Remove case endings (genetive, partitive, etc.)
  word = word
    // Partitive plural
    .replace(/(oita|öitä|eita|ita|itä)$/, '')
    // Partitive singular  
    .replace(/(aa|ää|ta|tä)$/, '')
    // Illative
    .replace(/(seen|siin|hun|hyn|hön)$/, '')
    // Inessive/Elative/Adessive/Ablative/Allative
    .replace(/(ssa|ssä|sta|stä|lla|llä|lta|ltä|lle)$/, '')
    // Plural marker
    .replace(/(jen|en|in|ien|ten|den|tten)$/, '');

  // Don't return too-short stems (avoid over-stemming)
  if (word.length < 3) {
    return original;
  }

  return word;
}
