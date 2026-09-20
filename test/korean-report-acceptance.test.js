'use strict';
const test=require('node:test');
const {cases}=require('./fixtures/korean-report-criteria');
for(const c of cases)test(`[PDF p.${c.pages}] ${c.id} ${c.category}: ${c.label}`,c.verify);
