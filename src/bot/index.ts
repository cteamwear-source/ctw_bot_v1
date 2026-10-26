import { getEnv } from "../config/env.js";
import { captureException, initSentry } from "../config/sentry.js";
import { handleWhatsAppMessage } from "../conversation/orderFlow.js";
import { begin, finish, abort } from "../session/hotPath.js";
import { runWithDraft } from "../session/draftStore.js";
import { COPY } from "../conversation/copy.js";
import { sendMessage } from "../whatsapp/metaClient.js";
import {
  handleAdminAction,
  handleMockupGenAction,
  handleAdminTextCommand,
  isAuthorizedAdmin,
} from "../admin/actions.js";
import { getChatPendingGenerationId } from "../mockup/generationStore.js";
import { attachPaymentProof } from "../mockup/paidGeneration.js";
import { runWithTiming, setTimingStep } from "../shared/timing.js";

let initialized = false;

export async function handleMessage(chatId: string, message: any) {
  // One structured [timing] log line per message (src/shared/timing.ts).
  return runWithTiming(message?.id, () => handleMessageInner(chatId, message));
}

async function handleMessageInner(chatId: string, message: any) {
  if (!initialized) {
    initSentry();
    getEnv(); // validate env
    initialized = true;
  }

  // One Redis round-trip: dedupe + lock + flood control + draft load.
  const msgId: string | undefined = message?.id ? String(message.id) : undefined;
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
  if (!start.allowed) {
    setTimingStep("rateLimited");
    await finish(chatId, start.token, undefined).catch(() => {});
    await sendMessage(chatId, COPY.floodCooldown).catch(() => {});
    return;
  }

  let failed = false;
  const draftCtx = await runWithDraft(chatId, start.draft, async (ctx) => {
    try {
      await routeMessage(chatId, message);
    } catch (err: any) {
      failed = true;
      console.error("Unhandled bot error:", err);
      captureException(err);
    }
    return ctx;
  });

  // One Redis round-trip: save the draft change + release the lock.
  // On failure the draft change is dropped and the dedupe marker deleted,
  // so Meta's redelivery is processed from the last good state.
  await finish(chatId, start.token, failed ? undefined : draftCtx.pending).catch((err) => {
    console.error("[bot] finish failed:", err);
    captureException(err);
  });
  if (failed) await abort(msgId).catch(() => {});
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
      await handleAdminAction(chatId, input, message);
      return;
    }
    if (input?.startsWith("mockupgen:")) {
      setTimingStep("mockupGenAction");
      await handleMockupGenAction(chatId, input, message);
      return;
    }

    // 2. Intercept admin typed commands (6-digit approval code, "CONFIRM <order>", etc.)
    if (input && isAuthorizedAdmin(chatId)) {
      const handled = await handleAdminTextCommand(chatId, input);
      if (handled) {
        setTimingStep("adminCommand");
        return;
      }
    }

    // 3. Paid mockup proof interception: customer sends proof photo while pending paid mockup
    if (isImage && imageId) {
      const pendingGenId = await getChatPendingGenerationId(chatId);
      if (pendingGenId) {
        console.log(`[bot] Found pending paid generation ${pendingGenId} for ${chatId}, attaching payment proof`);
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
