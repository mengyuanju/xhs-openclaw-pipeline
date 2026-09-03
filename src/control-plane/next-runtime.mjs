import 'server-only';

export function controlPlaneUrl(environment = process.env) {
  const raw = environment.CONTROL_PLANE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CONTROL_PLANE_URL must be an HTTP(S) URL without credentials');
  }
  url.pathname = url.pathname.replace(/\/$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export function executorNodeId(environment = process.env) {
  const value = environment.EXECUTOR_NODE_ID?.trim();
  if (!value || !/^[a-zA-Z0-9._:-]{1,100}$/u.test(value)) {
    throw new Error('EXECUTOR_NODE_ID is required when CONTROL_PLANE_URL is configured');
  }
  return value;
}
