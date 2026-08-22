# Privacy

Stored data is structural metadata: project paths/status evidence, timestamps, process identity/classification, shell CWD transitions, and native agent lifecycle metadata. Guardian does not store prompts, assistant content, reasoning, transcripts, raw terminal output, environment contents, credentials, `.env` contents, or secrets.

Operational event streams are bounded to 1,000 entries per stream. Logs default to 30-day retention and a combined 50 MiB cap. All processing is local; conversational answers are deterministic unless a future optional provider is explicitly configured.
