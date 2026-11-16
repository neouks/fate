// Opt-in preload for Node MCP servers that use fetch for search, but retain
// their own vetted-address http(s).request transport for URL extraction.
// NODE_USE_ENV_PROXY also replaces http(s) agents and breaks such transports.
import {EnvHttpProxyAgent,setGlobalDispatcher} from 'undici';

if(process.env.FATE_MCP_FETCH_PROXY==='1'){
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
