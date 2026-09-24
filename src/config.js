const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  dbPath: env.DB_PATH || './data/promo.db',
  mock: env.ML_MOCK === '1',
  concurrency: Math.max(1, Number(env.ML_CONCURRENCY) || 5),
  basicAuth: env.APP_USER && env.APP_PASSWORD ? { user: env.APP_USER, password: env.APP_PASSWORD } : null,
  ml: {
    clientId: env.ML_CLIENT_ID || '',
    clientSecret: env.ML_CLIENT_SECRET || '',
    redirectUri: env.ML_REDIRECT_URI || '',
    siteId: env.ML_SITE_ID || 'MLB',
    authHost: env.ML_AUTH_HOST || 'https://auth.mercadolivre.com.br',
    apiBase: env.ML_API_BASE || 'https://api.mercadolibre.com',
  },
};
