import { z } from 'zod';

// Envelope of a WhatsApp Business Account webhook. Unknown keys are ignored on purpose:
// Meta adds fields over time and a strict schema would start rejecting valid notifications.
export const WebhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            // Items are validated one by one so a single odd message cannot sink the whole batch.
            messages: z.array(z.unknown()).optional(),
            message_echoes: z.array(z.unknown()).optional()
          })
        })
      )
    })
  )
});
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

const Id = z.string().min(1).max(256);

/** A message a customer sent to the business (`messages` field). */
export const InboundMessageSchema = z
  .object({
    id: Id,
    // Phone number. Can be missing for users who adopted a username; then from_user_id identifies them.
    from: Id.optional(),
    from_user_id: Id.optional(),
    type: z.string(),
    text: z.object({ body: z.string().max(8192) }).optional()
  })
  .refine((m) => m.from || m.from_user_id, { message: 'message has neither from nor from_user_id' });
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

/** A message a person sent from the WhatsApp Business app on a coexistence number (`smb_message_echoes`). */
export const MessageEchoSchema = z
  .object({
    id: Id,
    to: Id.optional(),
    to_user_id: Id.optional()
  })
  .refine((m) => m.to || m.to_user_id, { message: 'echo has neither to nor to_user_id' });
export type MessageEcho = z.infer<typeof MessageEchoSchema>;

const nonEmpty = z.string().trim().min(1);

export const ConfigSchema = z
  .object({
    WHATSAPP_APP_SECRET: nonEmpty,
    WHATSAPP_VERIFY_TOKEN: nonEmpty,
    WHATSAPP_PHONE_NUMBER_ID: nonEmpty,
    OUTBOUND_MODE: z.enum(['mock', 'cloud']).default('mock'),
    WHATSAPP_ACCESS_TOKEN: z.string().trim().optional(),
    GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v27.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DB_PATH: nonEmpty.default('data/assistant.sqlite')
  })
  .refine((c) => c.OUTBOUND_MODE !== 'cloud' || !!c.WHATSAPP_ACCESS_TOKEN, {
    message: 'WHATSAPP_ACCESS_TOKEN is required when OUTBOUND_MODE=cloud'
  })
  .refine((c) => !/^replace-with/.test(c.WHATSAPP_APP_SECRET) && !/^replace-with/.test(c.WHATSAPP_VERIFY_TOKEN), {
    message: 'WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN still hold the .env.example placeholders'
  });
export type Config = z.infer<typeof ConfigSchema>;

/** Reads configuration from the environment and fails with a readable message. No insecure defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration (see .env.example): ${problems}`);
  }
  return parsed.data;
}
