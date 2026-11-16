import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBudgets,DEFAULT_BUDGETS} from '../src/config.ts';
import {resolveDataDir} from '../src/index.ts';
import {join} from 'node:path';
test('runtime home and profile determine separate data directories',()=>{const ctx={get(){return {name:'web',home:'E:/isolated-dsh'}}};assert.equal(resolveDataDir(ctx,{}),join('E:/isolated-dsh','mymemory','web'));assert.notEqual(resolveDataDir(ctx,{}),resolveDataDir({get(){return {name:'desktop',home:'E:/isolated-dsh'}}},{}));});
test('prototype property names are rejected as configuration keys',()=>{for(const key of ['constructor','toString','__proto__'])assert.throws(()=>validateBudgets(JSON.parse(`{"${key}":1}`)));});
test('budgets default to a small ON core block and reject unknown or unsafe limits',()=>{assert.ok(DEFAULT_BUDGETS.coreBudget>0&&DEFAULT_BUDGETS.coreBudget<=1024,'常驻块默认开启，预算保守（跨对话记忆的前提）');assert.equal(validateBudgets({maxResults:2}).maxResults,2);assert.throws(()=>validateBudgets({maxResults:999}));assert.throws(()=>validateBudgets({apiKey:'secret'}));assert.throws(()=>validateBudgets({retrievalBudget:-1}));});
