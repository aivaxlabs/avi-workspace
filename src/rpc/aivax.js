export const AIVAX_LOGIN_URL = 'https://inference.aivax.net/api/v1/auth/login';
export const AIVAX_RELAYS_URL = 'https://avi-relay.projpw.workers.dev/v1/relays';

export async function requestAivax(url, options) {
  const response = await fetch(url, { ...options, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'Authentication rejected. Please log in again with a valid login key.'
      : response.status === 429
        ? 'Too many requests. Wait a minute before trying again.'
        : 'The service is unavailable. Please try again.');
    error.status = response.status;
    throw error;
  }
  return response.json();
}
