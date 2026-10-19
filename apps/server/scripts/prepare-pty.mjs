// node-pty 1.1.0's macOS prebuild archive omits spawn-helper's executable bit.
// Repair only that package-owned helper at installation/build time.
import {createRequire} from 'node:module';
import {chmodSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';
if(process.platform==='darwin'){
 const require=createRequire(import.meta.url),root=path.dirname(require.resolve('node-pty/package.json'));
 for(const folder of [`prebuilds/${process.platform}-${process.arch}`,'build/Release']){
  const file=path.join(root,folder,'spawn-helper');
  if(existsSync(file))chmodSync(file,statSync(file).mode|0o111);
 }
}
