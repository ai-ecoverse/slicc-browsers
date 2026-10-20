import { outcome } from './guard-driver.mjs';

export async function createObserverTarget(reader, params, notes = []) {
  const result = await reader.send('Target.createTarget', { ...params, newWindow: true });
  try {
    const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId: result.targetId });
    if (!targetInfo || Object.hasOwn(targetInfo, 'openerId'))
      throw new Error('observer target must have no openerId');
    notes.push(`observer target ${result.targetId}: newWindow=true, openerId absent`);
    return result;
  } catch (error) {
    await outcome(reader.send('Target.closeTarget', { targetId: result.targetId }));
    throw error;
  }
}

export function discoveryViolation(events, declared) {
  if (declared) return null;
  const event = events.find((entry) =>
    ['Target.targetCreated', 'Target.targetInfoChanged'].includes(entry.method)
  );
  return event ? `discovery not declared, but transport delivered ${event.method}` : null;
}
