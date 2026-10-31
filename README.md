# bnbbot

## Telegram Gemini chat bot

This bot provides an AI chat in a private Telegram chat using the Gemini API.
It also has fixed, read-only Binance Agentic Wallet CLI commands: `/status`,
`/balance`, `/address`, and `/settings`. These commands run directly through
the local `baw` CLI and their output is not sent to Gemini. Gemini cannot invoke
the CLI. The bot does not expose transfer, swap, approval, contract-call,
signing, or mint commands. `/cek <address>` and pasted addresses or URLs use
the existing BNB Chain scanner instead of Gemini. Ordinary messages are sent
to Google Gemini; review Google's data-use terms before using it. Conversation
context is kept in memory per Telegram user, limited to the latest 20 messages,
and is lost when the process restarts. Use `/reset` to clear it.

1. Revoke any BotFather token that has been shared, then create a replacement.
2. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
   Review Gemini's current free-tier rate limits and data-use terms before use.
3. Set both secrets in your terminal; never put them in source code:

   ```sh
   export TELEGRAM_BOT_TOKEN='your-replacement-token'
   export GEMINI_API_KEY='your-gemini-api-key'
   npm start
   ```

4. Send `/id` to the bot to see your Telegram user ID. Stop the bot with
   `Ctrl+C`.
5. Restart with your ID allowlisted:

   ```sh
   export TELEGRAM_ALLOWED_USER_IDS='your-telegram-user-id'
   npm start
   ```

For multiple permitted users, use a comma-separated list of Telegram user IDs.
The bot only responds to private chats. Use `/start` after authorization.
Wallet commands are restricted to allowlisted Telegram IDs and fixed read-only
BAW arguments. Set `GEMINI_MODEL` to override the default `gemini-3.8-flash`
model. Keep all keys and allowed IDs private.