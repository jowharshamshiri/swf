import { VERSIONED_ID } from '@swf/core';
import { describe, expect, it } from 'vitest';
import { representationPolicyIssue } from '../src/index.js';

const policy = (id: unknown) => ({ id, representationOf: () => 'full' as const });

describe('representation policy IDs', () => {
  it('accepts exactly the versioned IDs core accepts', () => {
    const ids = [
      'host.depth/1',
      'Host.Depth/2',
      'host_depth/3',
      'ext.my-ext.policy/10',
      '9lives/1',
      'host.depth',
      'host.depth/0',
      'host.depth/01',
      '.host/1',
      '-host/1',
      '_host/1',
      'host depth/1',
      'host/depth/1',
      '',
    ];
    for (const id of ids) {
      expect(representationPolicyIssue(policy(id)) === null, id).toBe(VERSIONED_ID.test(id));
    }
    expect(representationPolicyIssue(policy('Host.Depth_A/1'))).toBeNull();
  });

  it('names what is wrong with an ID it refuses', () => {
    expect(representationPolicyIssue(policy('no version'))).toMatch(
      /versioned ID "<name>\/<version>".*"no version"/,
    );
    expect(representationPolicyIssue(policy(7))).toMatch(/versioned ID.*7/);
  });
});
