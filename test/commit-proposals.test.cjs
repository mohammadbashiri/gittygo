const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const proposals=require('../src/commit-proposals.cjs');
const sessions=require('../src/session-store.cjs');
const {createWorkspaceController}=require('../src/workspace-controller.cjs');
async function fixture(run){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'gittygo-proposals-'));const repo=path.join(home,'repo'),linked=path.join(home,'linked');await fs.mkdir(repo);
 const old=process.env.GITTYGO_STATE_DIR;process.env.GITTYGO_STATE_DIR=path.join(home,'state');
 const env={...process.env,HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env}).trim();
 const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../bin/gittygo.cjs'),'commit-message',...args,'--json'],{encoding:'utf8',env}));
 try{git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await fs.writeFile(path.join(repo,'file'),'seed');git('add','.');git('commit','-qm','seed');git('worktree','add','-qb','linked',linked);await run({repo,linked,git,cli,home});}
 finally{if(old===undefined)delete process.env.GITTYGO_STATE_DIR;else process.env.GITTYGO_STATE_DIR=old;await fs.rm(home,{recursive:true,force:true});}
}
test('CLI proposals reach independent native/web controllers and sessions, scoped to actual worktree and HEAD',async()=>fixture(async({repo,linked,git,cli})=>{
 const a=await createWorkspaceController(repo),b=await createWorkspaceController(repo),c=await createWorkspaceController(linked);
 try{
  const before=git('status','--porcelain');const set=cli('set','--repo',repo,'--message','Shared suggestion');
  const x=(await a.dispatch('uiRequests')).result.commitMessageRequest,y=(await b.dispatch('uiRequests')).result.commitMessageRequest;
  assert.equal(x.proposalId,set.proposalId);assert.deepEqual(x,y);assert.deepEqual((await a.dispatch('uiRequests')).result.commitMessageRequest,x);
  assert.equal((await c.dispatch('uiRequests')).result.commitMessageRequest,null,'sibling worktree is separate');
  assert.equal(cli('show','--repo',repo).proposal.message,'Shared suggestion');
  const other=cli('set','--repo',linked,'--message','Linked suggestion');assert.equal((await a.dispatch('selectWorktree',[await fs.realpath(linked)])).ok,true);
  assert.equal((await a.dispatch('uiRequests')).result.commitMessageRequest.proposalId,other.proposalId,'selected sibling uses its own proposal, not invoking session root');
  assert.equal((await b.dispatch('uiRequests')).result.commitMessageRequest.proposalId,set.proposalId);
  cli('set','--session',b.sessionId,'--message','Session-bound root suggestion');assert.equal((await b.dispatch('uiRequests')).result.commitMessageRequest.message,'Session-bound root suggestion');
  cli('clear','--repo',repo);assert.equal((await b.dispatch('uiRequests')).result.commitMessageRequest.message,'');assert.equal((await c.dispatch('uiRequests')).result.commitMessageRequest.message,'Linked suggestion');
  assert.equal(git('status','--porcelain'),before,'proposal operations do not stage/commit or edit repository files');
  git('commit','--allow-empty','-qm','next');assert.equal(await proposals.readProposal(repo),null,'old proposal does not repopulate after a commit');assert.equal((await proposals.readProposal(linked)).message,'Linked suggestion');
 }finally{await a.close();await b.close();await c.close();}
}));
test('proposal storage is bounded, atomic, private, and rejects symlinks/corrupt records',async()=>fixture(async({repo,home})=>{
 const p=await proposals.writeProposal(repo,'\0'.repeat(20000));assert.equal((await proposals.readProposal(repo)).message.length,20000);
 await assert.rejects(proposals.writeProposal(repo,'x'.repeat(20001)),/20000/);
 const dir=path.join(home,'state','commit-proposals'),file=path.join(dir,p.repoIdentity+'.json');assert.equal((await fs.stat(file)).mode&0o077,0);
 await fs.writeFile(file,'x'.repeat(170000));await assert.rejects(proposals.readProposal(repo),/Unsafe|large/);
 await fs.rm(file);await fs.symlink(path.join(home,'outside'),file);await assert.rejects(proposals.readProposal(repo));await fs.rm(file);
 await fs.rm(dir,{recursive:true});await fs.mkdir(path.join(home,'outside'));await fs.symlink(path.join(home,'outside'),dir);await assert.rejects(proposals.writeProposal(repo,'safe'),/Unsafe/);
}));
