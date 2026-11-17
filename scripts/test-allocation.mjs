import { computeAllocation } from '../src/allocation.mjs';
const role = { level: 56, exp: 500_000_000, nextExp: 0 };
const pets = [{ pet: { id: 'p1', form: 'SECOND', average: 170, level: 42 }, nextExp: 203_775_532 }, { pet: { id: 'p2', form: 'BABY', average: 120, level: 30 } }];
const skills = [{ id: 1, name: 'skillA', level: 1, nextExp: 100_000_000 }];
const anqi = { level: 60, nextExp: 0 };
const now = Date.now();
const a = computeAllocation({ role, pets, skills, anqi, activePetId: 'p2', cfg: { allowRoleLevel: true }, now });
console.log(JSON.stringify(a, null, 1));
if (a.sink !== 'skill') { console.error('FAIL: expected skill sink'); process.exit(1); }
console.log('test-allocation OK');
