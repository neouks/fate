/** A model may retry a failed read, but the host never replays a tool here.
 * Writes and arbitrary shell commands keep the existing two-failure guard. */
export function toolFailureLimit(name:string,args:unknown,error:string):number {
  if(name!=='http_request')return 2;
  const method=String((args as {method?:unknown})?.method??'GET').toUpperCase();
  if(!['GET','HEAD','OPTIONS'].includes(method))return 2;
  try {
    const result=JSON.parse(error) as {error_code?:string};
    return ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(result.error_code??'')?3:2;
  } catch {return 2;}
}
