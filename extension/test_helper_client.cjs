const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function setup(config){
 const calls=[];
 const context={URL,Headers,AbortSignal,chrome:{storage:{local:{get:async()=>config}}},
  fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true})};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'helper-client.js'),'utf8'),context);
 return {client:context.SsakHelper,calls};
}
test('token is delivered only to loopback without redirects',async()=>{
 const {client,calls}=setup({helperUrl:'http://127.0.0.1:8787',helperToken:'s'.repeat(32)});
 await client.request('/jobs',{method:'POST',headers:{'Content-Type':'application/json'}});
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers.get('X-SSAK-Token'),'s'.repeat(32));
 assert.equal(calls[0].options.redirect,'error');
 assert.equal(calls[0].options.headers.get('Content-Type'),'application/json');
});
test('missing token and remote endpoints fail before fetching',async()=>{
 for(const url of ['https://evil.example','http://127.0.0.1.evil.example','http://name@127.0.0.1','http://localhost/path','http://localhost/?x=1']){
  const {client,calls}=setup({helperUrl:url,helperToken:'s'.repeat(32)});
  await assert.rejects(client.request('/jobs'));assert.equal(calls.length,0);
 }
 const {client,calls}=setup({});await assert.rejects(client.request('/jobs'));assert.equal(calls.length,0);
});
test('all consumer surfaces load and call shared transport',()=>{
 for(const file of ['popup.js','options.js','background.js'])assert.match(fs.readFileSync(path.join(__dirname,file),'utf8'),/SsakHelper.request/);
 for(const file of ['popup.html','options.html'])assert.match(fs.readFileSync(path.join(__dirname,file),'utf8'),/helper-client.js/);
 assert.match(fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),/importScripts\('helper-client.js'\)/);
});
