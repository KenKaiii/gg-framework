// @ts-check
// Seat helper for sit-to-activity: put the player on a slot (pose + facing), stand them back up afterwards.
/** @param {any} S @param {any} R room @param {any} slot @returns {() => void} stand-up function */
export function sitPlayer(S, R, slot) {
  const me = S.me, prev = { x: me.pos.x, z: me.pos.z };
  if (me.W.scene !== R.root) { /* player always lives in the current room's root; slot coords are room-local */ }
  me.path = null; me.sitting = true; me.root.position.set(slot.x, slot.y || 0, slot.z); me.root.rotation.y = slot.face || 0;
  me.av.play(slot.anim || 'Sit_Chair_Idle', { fade: 0.3 }); me.lockAnim = 1e9;
  return () => { me.sitting = false; me.lockAnim = 0; me.root.position.set(prev.x, 0, prev.z); me.av.play('Idle', { fade: 0.2 }); };
}
