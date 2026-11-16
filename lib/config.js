import {fail} from './safety.js';
export const DEFAULT_BUDGETS={coreBudget:900,retrievalBudget:512,profileBudgetChars:4096,maxMemoryChars:2000,maxResults:8,extractionInputChars:1000,extractionOutputTokens:256,minIntervalMs:60000,dailyLimit:20,maxQueue:8,timeoutMs:10000,nearDupPercent:90,spillThreshold:60000};
const ranges                               ={coreBudget:[0,1024],retrievalBudget:[0,8192],profileBudgetChars:[512,16384],maxMemoryChars:[16,2000],maxResults:[1,20],extractionInputChars:[16,4000],extractionOutputTokens:[16,1024],minIntervalMs:[1000,86400000],dailyLimit:[0,1000],maxQueue:[1,32],timeoutMs:[100,30000],nearDupPercent:[50,100],spillThreshold:[1000,10000000]};
export function validateBudgets(input    )                        {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_BUDGETS');
  for(const [key,value] of Object.entries(input)){if(!Object.hasOwn(ranges,key))fail('INVALID_BUDGETS');const range=ranges[key];if(!Number.isInteger(value)||Number(value)<range[0]||Number(value)>range[1])fail('INVALID_BUDGETS');}
  return {...DEFAULT_BUDGETS,...input};
}
