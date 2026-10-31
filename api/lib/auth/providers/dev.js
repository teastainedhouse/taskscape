import { parseCookies } from '../../http.js';

export const DEV_HEADER = 'x-dev-user';
export const DEV_COOKIE = 'taskscape_dev_user';

/**
 * Local-only identity: pick a configured user by header, cookie, or default.
 * @param {Request} request
 * @param {{default_user: string, users: Array<{id:string,name:string,email?:string,groups?:string[]}>}} cfg
 * @returns {{id:string, name:string, email?:string, groups:string[]}|null}
 */
export function fromDev(request, cfg) {
  const wanted =
    request.headers.get(DEV_HEADER) ||
    parseCookies(request.headers.get('cookie'))[DEV_COOKIE] ||
    cfg.default_user;
  const u = cfg.users.find((x) => x.id === wanted);
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, groups: u.groups ?? [] };
}
