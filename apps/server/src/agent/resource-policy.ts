/** Keep resource settings and runner assembly on the same role boundary. */
export function roleSupportsMcp(role:string):boolean {
 return role !== 'retester';
}
