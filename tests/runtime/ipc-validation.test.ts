import test from 'node:test';
import assert from 'node:assert/strict';
import { listProjectAgentSkillRegistrySchema } from '../../electron/main/ipc-validation.ts';

test('project skill registry IPC accepts the public project id argument', () => {
  assert.equal(listProjectAgentSkillRegistrySchema.parse('project_123'), 'project_123');
  assert.throws(() => listProjectAgentSkillRegistrySchema.parse({ projectId: 'project_123' }));
});
