export async function adminFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.assign('/login');
  }
  return response;
}
