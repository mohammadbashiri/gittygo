const { serializeError } = require('./workspace-controller.cjs');

// The native dialog is presentation only; authorization/freshness lives in the controller.
async function invokeNative(controller, method, args, showMessageBox) {
  if (!controller) return { ok: false, error: { message: 'Workspace is not ready.', details: '' } };
  try {
    let reply = await controller.dispatch(method, args);
    if (reply.confirmation) {
      const spec = reply.confirmation;
      const answer = await showMessageBox({
        type: ['pull', 'push'].includes(method) ? 'question' : 'warning', title: spec.title, message: spec.message, detail: spec.detail,
        buttons: spec.choices, defaultId: 0, cancelId: 0,
      });
      reply = await controller.dispatch('confirm', [spec.id, answer.response]);
    }
    return reply;
  } catch (error) { return { ok: false, error: serializeError(error) }; }
}
module.exports = { invokeNative };
