# vllm-cli-local-chat

A simple command line chat interface for a local vLLM server.

It is set up for:

- endpoint: `http://127.0.0.1:8000/v1/chat/completions`
- model: `Qwen3.5-9B-local`

## Run

```powershell
npm start
```

No install step is needed because the app uses only built-in Node features.

## Controls

- Type your message and press `Enter` to chat.
- Press `Ctrl+O` at the prompt to open the options panel.
- Use `/config` if your terminal does not pass through `Ctrl+O`.
- Use `/clear` to clear conversation history.
- Use `/status` to show the current configuration.
- Use `/help` to show commands.
- Use `/quit` to exit.

## Notes

- The CLI can stream both `reasoning` and final assistant `content` when the model emits them separately.
- Assistant replies render common Markdown in the terminal, including headings, lists, links, inline code, and fenced code blocks.
- On interactive startup, the CLI queries vLLM's `/v1/models` endpoint and lets you pick which served model to use.
- Settings are saved to `vllm-cli-local-chat.config.json` in the project root.
- Default thinking-mode sampling is set to `temperature=1.0`, `top_p=0.95`, `top_k=20`, `min_p=0.0`, `presence_penalty=1.5`, and `repetition_penalty=1.0`.
- The default system prompt encourages the model to provide a final answer after reasoning so you can see both sections.
