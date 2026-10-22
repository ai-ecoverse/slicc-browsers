import test from 'node:test';
import { partitions, sweep } from './guard-sweep.mjs';

test(
  `without a guard every control passes and every protection fails: ${partitions['others'].join(', ')}`,
  {
    timeout: 1200000,
  },
  () => sweep('others')
);
