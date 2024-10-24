# Open Interpreter Plugin for Obsidian

This plugin integrates Open Interpreter with Obsidian, allowing you to run AI-powered automations directly within your notes using natural language commands.

## Features

- Execute natural language commands to automate tasks within your Obsidian vault
- Interactive chat interface for communicating with the interpreter
- Automatic installation check and guidance for Open Interpreter
- Seamless integration with your Obsidian vault, with full access to read, write, and edit Markdown files

## Installation

1. Install the plugin from the Obsidian Community Plugins browser.
2. Enable the plugin in Obsidian settings.
3. Ensure [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter) is installed on your system. If not, the plugin will guide you through the installation process.

## Usage

1. Use the command palette (Cmd/Ctrl + P) and search for "AI Command".
2. Enter your natural language command in the input modal that appears.
3. Interact with the interpreter through the chat interface to automate tasks within your vault.

## Requirements

- Obsidian v0.15.0 or higher
- Open Interpreter installed on your system

## Configuration

The plugin automatically detects your Obsidian vault path and sets up the necessary environment for Open Interpreter to run within your vault context.

## Troubleshooting

If you encounter issues:

1. Ensure Open Interpreter is correctly installed and accessible from your terminal.
2. Check the console for any error messages.
3. Verify that your OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable is set correctly, depending on your selected provider.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.
