'use strict';

/**
 * TEDDYXMDHOST runtime configuration.
 * Set secret values in Heroku Config Vars; never commit real credentials here.
 * The application reads these environment variables directly at runtime.
 */
module.exports = Object.freeze({
  // MongoDB Atlas — required
  MONGODB_URI: process.env.MONGODB_URI || process.env.MONGODB_URL || '',
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'teddyxhost',

  // Server / security
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || '8080',
  HOST: process.env.HOST || '0.0.0.0',
  SESSION_SECRET: process.env.SESSION_SECRET || '',

  // Public URLs — optional when frontend and API run in the same Heroku app.
// Payment callbacks derive the URL from the incoming request when these are blank.
  FRONTEND_URL: process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || '',
  BACKEND_URL: process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '',
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || '',

  // Paystack payment keys — optional unless payments are enabled
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY || '',
  PAYSTACK_SECRET_KEY_KE: process.env.PAYSTACK_SECRET_KEY_KE || '',

  // Logging / integration flags
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  JHP_PLATFORM: process.env.JHP_PLATFORM || '',
  JHP_PLATFORM_URL: process.env.JHP_PLATFORM_URL || '',
  BASE_PATH: process.env.BASE_PATH || '',
  REPL_ID: process.env.REPL_ID || '',
});
