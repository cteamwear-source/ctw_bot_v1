import { getEnv } from "../config/env.js";
import { captureException, initSentry } from "../config/sentry.js";
import { handleWhatsAppMessage } from "../conversation/orderFlow.js";
import { begin, finish, abort } from "../session/hotPath.js";
import { runWithDraft } from "../session/draftStore.js";
import { COPY } from "../conversation/copy.js";
import { sendMessage } from "../whatsapp/metaClient.js";
import { isAuthorizedAdmin } from "../admin/auth.js";
// Admin handlers, generation store and paid-mockup flow pull in Sheets,
// Blob and the mockup pipeline: they are `await import()`ed only on the
// paths that need them (T5 cold start).
import { runWithTiming, setTimingStep } from "../shared/timing.js";
import { customerWasNotified } from "../shared/customerNotified.js";
import type { OrderDraft } from "../conversation/draft.js";

let initialized = false;

export async function handleMessage(chatId: string, message: any) {
  // One structured [timing] log line per message (src/shared/timing.ts).
  return runWithTiming(message?.id, () => handleMessageInner(chatId, message));
}

async function handleMessageInner(chatId: string, message: any) {
  const msgId: string | undefined = message?.id ? String(message.id) : undefined;
  // Lock token still to be released by `finish()` in the finally block.
  let token: string | undefined;
  let pending: OrderDraft | null | undefined;
  let failed = false;

  try {
    if (!initialized) {
      initSentry();
      getEnv(); // validate env
      initialized = true;
    }

    // One Redis round-trip: dedupe + lock + flood control + draft load.
    const start = await begin(chatId, msgId);
    if (!start.isNew) {
      setTimingStep("duplicate");
      return;
    }
    if (!start.locked) {
      setTimingStep("busy");
      await sendMessage(chatId, COPY.busyReprompt).catch(() => {});
      return;
    }
    token = start.token;
    if (!start.allowed) {
      setTimingStep("rateLimited");
      await finish(chatId, token, undefined).catch(() => {});
      token = undefined;
      await sendMessage(chatId, COPY.floodCooldown).catch(() => {});
      return;
    }

    const draftCtx = await runWithDraft(chatId, start.draft, async (ctx) => {
      await routeMessage(chatId, message);
      return ctx;
    });
    pending = draftCtx.pending;
  } catch (err: any) {
    // Every failure gets exactly one customer reply (T8). The order flow
    // sends its own and marks the error; everything else is apologised here.
    failed = true;
    console.error("Unhandled bot error:", err);
    captureException(err);
    if (!customerWasNotified(err)) {
      await sendMessage(chatId, COPY.genericError).catch(() => {});
    }
  } finally {
    // One Redis round-trip: save the draft change + release the lock.
    // On failure the draft change is dropped and the dedupe marker deleted,
    // so Meta's redelivery is processed from the last good state.
    await finish(chatId, token, failed ? undefined : pending).catch((err) => {
      console.error("[bot] finish failed:", err);
      captureException(err);
    });
    if (failed) await abort(msgId).catch(() => {});
  }
}

async function routeMessage(chatId: string, message: any) {
  {
    const input =
      message.text?.body ||
      message.interactive?.button_reply?.id ||
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.id ||
      message.interactive?.list_reply?.title ||
      message.button?.payload ||
      message.button?.text;
    const isImage = !!message.image;
    const imageId = message.image?.id;

    // 1. Intercept admin button actions
    if (input?.startsWith("admin:")) {
      setTimingStep("adminAction");
      const { handleAdminAction } = await import("../admin/actions.js");
      await handleAdminAction(chatId, input, message);
      return;
    }
    if (input?.startsWith("mockupgen:")) {
      setTimingStep("mockupGenAction");
      const { handleMockupGenAction } = await import("../admin/actions.js");
      await handleMockupGenAction(chatId, input, message);
      return;
    }

    // 2. Intercept admin typed commands (6-digit approval code, "CONFIRM <order>", etc.)
    if (input && isAuthorizedAdmin(chatId)) {
      const { handleAdminTextCommand } = await import("../admin/actions.js");
      const handled = await handleAdminTextCommand(chatId, input);
      if (handled) {
        setTimingStep("adminCommand");
        return;
      }
    }

    // 3. Paid mockup proof interception: customer sends proof photo while pending paid mockup
    if (isImage && imageId) {
      const { getChatPendingGenerationId } = await import("../mockup/generationStore.js");
      const pendingGenId = await getChatPendingGenerationId(chatId);
      if (pendingGenId) {
        console.log(`[bot] Found pending paid generation ${pendingGenId} for ${chatId}, attaching payment proof`);
        const { attachPaymentProof } = await import("../mockup/paidGeneration.js");
        const result = await attachPaymentProof(pendingGenId, imageId);
        if (result.ok) {
          setTimingStep("paidMockupProof");
          await sendMessage(chatId, COPY.mockupPaidProofAck).catch(() => {});
          return;
        }
      }
    }

    // 4. Enter customer conversation state machine
    console.log(`[bot] calling handleWhatsAppMessage`);
    await handleWhatsAppMessage(chatId, message);
    console.log(`[bot] handleWhatsAppMessage completed`);
  }
}
