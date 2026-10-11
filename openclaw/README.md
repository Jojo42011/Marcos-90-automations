# Marco Harvey — OpenClaw (WhatsApp)

OpenClaw is the messaging pipe. Harvey on `marco-90-automation` is the brain.

## Current account-isolation boundary

The source retains the brain routes below, but with ACCOUNT_ISOLATION=true the gateway does not route unscoped OpenClaw/machine tokens into personal accounts. Root gateway credentials are not inherited by account workers. Deploying this separate gateway alone does not make WhatsApp work with the current account-isolated app. Account-aware integration is required; these commands describe the optional gateway, not verified production connectivity.

## Retained brain endpoints

- `POST https://marco-90-automation.fly.dev/v1/chat/completions`
- `POST https://marco-90-automation.fly.dev/v1/sessions/reset`
- `GET https://marco-90-automation.fly.dev/v1/sessions/harvey`

## Deploy gateway

```powershell
fly launch --name harvey-claw --region dfw --no-deploy --config openclaw/fly.toml
fly volumes create harvey_openclaw_data --size 1 -a harvey-claw -r dfw
fly deploy -a harvey-claw --config openclaw/fly.toml
```

## WhatsApp setup (after deploy)

1. Edit `openclaw/openclaw.json` — set `allowFrom` to Marco's WhatsApp number in E.164 (`+1...`).
2. Copy config to the Fly volume:

```bash
fly ssh console -a harvey-claw
mkdir -p /data
cat > /data/openclaw.json
# paste JSON, then Ctrl+D
exit
fly machine restart -a harvey-claw
```

3. Link WhatsApp (personal QR — Meta ToS applies):

```bash
fly ssh console -a harvey-claw
openclaw channels login whatsapp
```

Scan QR in WhatsApp → Linked Devices.

## Reset conversation thread

Message Harvey: `reset thread` (memory in SQLite is preserved).

## Logs

```bash
fly logs -a harvey-claw
fly logs -a marco-90-automation
```
