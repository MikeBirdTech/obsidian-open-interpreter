import {
  Plugin,
  Notice,
  Modal,
  App,
  Setting,
  PluginSettingTab,
  Platform,
  DropdownComponent,
  FileSystemAdapter,
} from "obsidian";
import { exec, ChildProcess, spawn } from "child_process";
import * as os from "os";
import * as fs from "fs/promises";
import path from "path";

interface OpenInterpreterSettings {
  provider: "OpenAI" | "Anthropic" | "Groq";
  model: string;
  contextWindow: string;
  maxTokens: string;
  llmSupportsFunctions: boolean;
  llmSupportsVision: boolean;
}

const DEFAULT_SETTINGS: OpenInterpreterSettings = {
  provider: "Anthropic",
  model: "claude-3-5-sonnet-20241022",
  contextWindow: "4000",
  maxTokens: "2048",
  llmSupportsFunctions: false,
  llmSupportsVision: false,
};

interface SecureStorage {
  keys: {
    openai?: string;
    anthropic?: string;
    groq?: string;
  };
}

class SecureKeyStorage {
  private storagePath: string;
  private keys: SecureStorage = { keys: {} };

  constructor(private app: App) {
    const vaultPath = (app.vault.adapter as any).getBasePath();
    this.storagePath = path.join(vaultPath, ".obsidian", ".keys.json");
  }

  async initialize() {
    try {
      await this.ensureStorageFile();
      await this.loadKeys();
    } catch (error) {
      console.error("Error initializing secure storage:", error);
      new Notice("Failed to initialize secure storage");
    }
  }

  private async ensureStorageFile() {
    try {
      // Create directories if needed
      const dirPath = path.dirname(this.storagePath);
      const vaultPath = (this.app.vault.adapter as any).getBasePath();

      // Update root .gitignore
      const gitignorePath = path.join(vaultPath, ".gitignore");
      const ignorePattern = ".obsidian/.keys.json";

      try {
        let gitignoreContent = "";
        try {
          gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
        } catch {
          // File doesn't exist yet
        }

        const lines = gitignoreContent.split("\n");
        if (!lines.some((line) => line.trim() === ignorePattern)) {
          const newContent = gitignoreContent
            ? gitignoreContent.endsWith("\n")
              ? gitignoreContent + ignorePattern + "\n"
              : gitignoreContent + "\n" + ignorePattern + "\n"
            : ignorePattern + "\n";

          await fs.writeFile(gitignorePath, newContent);
        }
      } catch (error) {
        console.error("Error updating .gitignore:", error);
        new Notice(
          "Failed to update .gitignore. Please add .obsidian/.keys.json manually."
        );
      }
    } catch (error) {
      console.error("Error ensuring storage file:", error);
      throw error;
    }
  }

  private async loadKeys() {
    try {
      const content = await fs.readFile(this.storagePath, "utf-8");
      this.keys = JSON.parse(content);
    } catch (error) {
      console.error("Error loading keys:", error);
      this.keys = { keys: {} };
    }
  }

  private async saveKeys() {
    try {
      await fs.writeFile(
        this.storagePath,
        JSON.stringify(this.keys, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error("Error saving keys:", error);
      throw error;
    }
  }

  async getKey(provider: string): Promise<string | undefined> {
    const key = provider.toLowerCase() as "openai" | "anthropic" | "groq";
    return this.keys.keys[key];
  }

  async setKey(provider: string, key: string) {
    const keyName = provider.toLowerCase() as "openai" | "anthropic" | "groq";
    this.keys.keys[keyName] = key;
    await this.saveKeys();
  }

  async removeKey(provider: string) {
    const keyName = provider.toLowerCase() as "openai" | "anthropic" | "groq";
    delete this.keys.keys[keyName];
    await this.saveKeys();
  }
}

class InstallationGuideModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    let { contentEl } = this;
    contentEl.setText("Open Interpreter is not installed.");
    contentEl.createEl("p", {
      text: "To install, run the following command in your terminal:",
    });
    contentEl.createEl("pre", { text: "pip install open-interpreter" });
    contentEl.createEl("p", { text: "For more information, visit:" });
    contentEl.createEl("a", {
      text: "Open Interpreter Documentation",
      href: "https://docs.openinterpreter.com/getting-started/introduction",
    });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class InterpreterInputModal extends Modal {
  result: string = "";
  onSubmit: (result: string) => void;

  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("interpreter-modal-content");

    contentEl.createEl("h2", {
      text: "Enter command for Open Interpreter",
      cls: "interpreter-modal-title",
    });

    const inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "interpreter-modal-input",
      placeholder: "Enter your command...",
    });

    inputEl.addEventListener("input", (e) => {
      this.result = (e.target as HTMLInputElement).value;
    });

    inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.close();
        this.onSubmit(this.result);
      }
    });

    inputEl.focus();

    const submitButton = contentEl.createEl("button", {
      text: "Submit",
      cls: "submit-button",
    });

    submitButton.addEventListener("click", () => {
      this.close();
      this.onSubmit(this.result);
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class InterpreterChatModal extends Modal {
  private interpreter: ChildProcess;
  private inputEl!: HTMLTextAreaElement;
  private outputEl!: HTMLElement;
  private buttonContainer!: HTMLElement;
  private yesButton!: HTMLButtonElement;
  private noButton!: HTMLButtonElement;
  private sendButton!: HTMLButtonElement;

  constructor(app: App, interpreter: ChildProcess) {
    super(app);
    this.interpreter = interpreter;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("interpreter-modal-content");

    contentEl.createEl("h2", { text: "Open Interpreter Chat" });

    this.outputEl = contentEl.createEl("div", { cls: "interpreter-output" });

    this.createInputArea();
    this.createButtons();

    this.setupInterpreterListeners();
  }

  private setupInterpreterListeners() {
    if (this.interpreter.stdout) {
      this.interpreter.stdout.on("data", (data) => {
        this.appendOutput(data.toString());
      });
    }

    if (this.interpreter.stderr) {
      this.interpreter.stderr.on("data", (data) => {
        this.appendOutput(`Error: ${data.toString()}`, true);
      });
    }

    this.interpreter.on("close", (code) => {
      this.appendOutput(`Interpreter closed with code ${code}`);
      this.close();
    });
  }

  onClose() {
    this.interpreter.kill();
    const { contentEl } = this;
    contentEl.empty();
  }

  private appendOutput(text: string, isError: boolean = false) {
    const chunks = text.match(/.{1,1000}/g) || [];

    chunks.forEach((chunk) => {
      const p = this.outputEl.createEl("p");
      p.textContent = chunk;
      if (isError) {
        p.style.color = "red";
      }
    });

    this.outputEl.scrollTop = this.outputEl.scrollHeight;

    if (text.trim().endsWith("Would you like to run this code? (y/n)")) {
      this.showYesNoButtons();
    } else {
      this.showInputArea();
    }
  }

  private sendMessage(overrideMessage?: string) {
    let message: string;
    if (overrideMessage) {
      message = overrideMessage;
    } else {
      message = this.inputEl.value;
      this.inputEl.value = "";
    }

    if (this.interpreter.stdin) {
      this.interpreter.stdin.write(message + "\n");
    }
    this.appendOutput(`You: ${message}`);
    this.showInputArea();
  }

  private createInputArea() {
    this.inputEl = this.contentEl.createEl("textarea", {
      cls: "interpreter-input",
    });
  }

  private createButtons() {
    // Create Yes/No buttons container
    this.buttonContainer = this.contentEl.createEl("div", {
      cls: "yes-no-buttons",
    });

    // Create Yes button
    this.yesButton = this.buttonContainer.createEl("button", {
      text: "Yes",
      cls: "interpreter-chat-button yes",
    });
    this.yesButton.onclick = () => this.sendMessage("y");

    // Create No button
    this.noButton = this.buttonContainer.createEl("button", {
      text: "No",
      cls: "interpreter-chat-button no",
    });
    this.noButton.onclick = () => this.sendMessage("n");

    // Create Send button
    this.sendButton = this.contentEl.createEl("button", {
      text: "Send",
      cls: "interpreter-chat-button send",
    });
    this.sendButton.onclick = () => this.sendMessage();

    // Initially hide the Yes/No buttons
    this.buttonContainer.style.display = "none";
  }

  private showInputArea() {
    this.inputEl.style.display = "block";
    this.buttonContainer.style.display = "none";
    this.sendButton.style.display = "block";
  }

  private showYesNoButtons() {
    this.inputEl.style.display = "none";
    this.buttonContainer.style.display = "flex";
    this.sendButton.style.display = "none";
  }
}

export default class OpenInterpreterPlugin extends Plugin {
  settings: OpenInterpreterSettings = DEFAULT_SETTINGS;
  keyStorage!: SecureKeyStorage;
  private interpreterInstalled: boolean = false;

  async onload() {
    this.keyStorage = new SecureKeyStorage(this.app);
    await this.keyStorage.initialize();
    await this.loadSettings();

    this.addSettingTab(new OpenInterpreterSettingTab(this.app, this));

    this.addCommand({
      id: "run-interpreter",
      name: "AI Command",
      callback: () => this.runInterpreter(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async checkInterpreterInstallation(): Promise<void> {
    return new Promise((resolve) => {
      const command = '$SHELL -i -c "which interpreter"';
      console.log("Executing command:", command);

      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error("Error finding interpreter:", error);
          console.log("Stderr:", stderr);
          this.interpreterInstalled = false;
        } else {
          const interpreterPath = stdout.trim();
          console.log("Interpreter found at:", interpreterPath);
          this.interpreterInstalled = !!interpreterPath;
        }
        console.log("Interpreter installed:", this.interpreterInstalled);
        resolve();
      });
    });
  }

  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    console.error("Could not determine vault path");
    return null;
  }

  private getApiKey(provider: string): string | undefined {
    console.log("All environment variables:", Object.keys(process.env));
    console.log("Complete env object:", JSON.stringify(process.env, null, 2));

    switch (provider) {
      case "OpenAI":
        return process.env.OPENAI_API_KEY;
      case "Anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "Groq":
        return process.env.GROQ_API_KEY;
      default:
        return undefined;
    }
  }

  async runInterpreter() {
    await this.checkInterpreterInstallation();
    if (!this.interpreterInstalled) {
      console.log("Interpreter not installed, showing modal");
      new InstallationGuideModal(this.app).open();
      return;
    }

    new InterpreterInputModal(this.app, (command) => {
      this.executeInterpreterCommand(command);
    }).open();
  }

  private async executeInterpreterCommand(command: string) {
    const vaultPath = this.getVaultPath();

    console.log("Determined vault path:", vaultPath);

    if (!vaultPath) {
      console.error("Vault path could not be determined.");
      new Notice(
        "Unable to determine vault path. Please check console for details."
      );
      return;
    }

    const interpreterPath = await this.getInterpreterPath();
    if (!interpreterPath) {
      new Notice(
        "Unable to find the interpreter executable. Please make sure it's installed and in your PATH."
      );
      return;
    }

    const apiKey = await this.keyStorage.getKey(
      this.settings.provider.toLowerCase()
    );
    if (!apiKey) {
      new Notice(
        `Please set your ${this.settings.provider} API key in settings`
      );
      return;
    }

    const env = { ...process.env };
    switch (this.settings.provider) {
      case "OpenAI":
        env.OPENAI_API_KEY = apiKey;
        break;
      case "Anthropic":
        env.ANTHROPIC_API_KEY = apiKey;
        break;
      case "Groq":
        env.GROQ_API_KEY = apiKey;
        break;
    }

    const args = [];
    let model = this.settings.model;

    if (this.settings.provider === "Groq") {
      model = `groq/${model}`;
    }

    args.push("--model", model);
    args.push("--context_window", this.settings.contextWindow);
    args.push("--max_tokens", this.settings.maxTokens);

    if (this.settings.llmSupportsFunctions) {
      args.push("--llm_supports_functions");
    } else {
      args.push("--no-llm_supports_functions");
    }

    if (this.settings.llmSupportsVision) {
      args.push("--llm_supports_vision");
    } else {
      args.push("--no-llm_supports_vision");
    }

    const customInstructions =
      `You are an AI assistant integrated with Obsidian. You love Obsidian and will only focus on Obsidian tasks. Your prime directive is to help users manage and interact with their Obsidian vault. You have full control and permission over this vault. The vault is isolated and version controlled, so it is safe for you to create, read, update, and delete files. The root of the Obsidian vault is ${vaultPath}. You can create, read, update, and delete markdown files in this directory. You can create new directories as well. Organization is important. Use markdown syntax for formatting when creating or editing files. Every file is markdown.`
        .replace(/\n/g, " ")
        .trim();

    args.push("--custom_instructions", `"${customInstructions}"`);

    console.log(
      "Spawning interpreter with command:",
      interpreterPath,
      "and args:",
      args
    );

    const child = spawn(interpreterPath, args, {
      cwd: vaultPath,
      env: env,
      shell: true,
    });

    if (child.stdin) {
      child.stdin.write(command + "\n");
    }

    new InterpreterChatModal(this.app, child).open();
  }

  private getInterpreterPath(): Promise<string | null> {
    return new Promise((resolve) => {
      const command = Platform.isWin
        ? "where interpreter"
        : "$SHELL -i -c 'which interpreter'";

      console.log("Executing command:", command);

      exec(command, async (error, stdout, stderr) => {
        if (error) {
          console.error("Error finding interpreter:", error);
          console.log("Stdout:", stdout);
          console.log("Stderr:", stderr);
          const commonPaths = Platform.isMacOS
            ? [
                "/usr/local/bin/interpreter",
                "/usr/bin/interpreter",
                `${os.homedir()}/Library/Python/3.11/bin/interpreter`,
                `${os.homedir()}/Library/Python/3.10/bin/interpreter`,
                `${os.homedir()}/Library/Python/3.9/bin/interpreter`,
              ]
            : Platform.isLinux
            ? ["/usr/local/bin/interpreter", "/usr/bin/interpreter"]
            : ["C:\\Python\\Scripts\\interpreter.exe"];

          for (const path of commonPaths) {
            try {
              await fs.access(path);
              resolve(path);
              return;
            } catch {
              // Path doesn't exist or is not accessible, continue to next path
            }
          }
          resolve(null);
        } else {
          console.log("Interpreter found at:", stdout.trim());
          resolve(stdout.trim());
        }
      });
    });
  }

  onunload() {
    console.log("unloading open interpreter plugin");
  }
}

class OpenInterpreterSettingTab extends PluginSettingTab {
  plugin: OpenInterpreterPlugin;
  private modelDropdown: DropdownComponent | null = null;

  constructor(app: App, plugin: OpenInterpreterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Select the LLM provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("OpenAI", "OpenAI")
          .addOption("Anthropic", "Anthropic")
          .addOption("Groq", "Groq")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value as
              | "OpenAI"
              | "Anthropic"
              | "Groq";
            await this.plugin.saveSettings();
            this.updateModelOptions();
          })
      );

    // API Key settings
    const providers = ["OpenAI", "Anthropic", "Groq"];
    for (const provider of providers) {
      const currentKey = await this.plugin.keyStorage.getKey(
        provider.toLowerCase()
      );

      new Setting(containerEl)
        .setName(`${provider} API Key`)
        .setDesc(`Enter your ${provider} API key`)
        .addText((text) => {
          text
            .setPlaceholder(`Enter ${provider} API key`)
            .setValue(currentKey || "")
            .onChange(async (value) => {
              if (value) {
                await this.plugin.keyStorage.setKey(
                  provider.toLowerCase(),
                  value
                );
              } else {
                await this.plugin.keyStorage.removeKey(provider.toLowerCase());
              }
            });
          text.inputEl.type = "password";
          text.inputEl.dataset.lpignore = "true";
        });
    }

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Select the LLM model")
      .addDropdown((dropdown) => {
        this.modelDropdown = dropdown;
        this.updateModelOptions();
        dropdown.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Context Window")
      .setDesc("Set the context window size")
      .addText((text) =>
        text
          .setPlaceholder("Enter context window size")
          .setValue(this.plugin.settings.contextWindow)
          .onChange(async (value) => {
            this.plugin.settings.contextWindow = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max Tokens")
      .setDesc("Set the maximum number of tokens")
      .addText((text) =>
        text
          .setPlaceholder("Enter max tokens")
          .setValue(this.plugin.settings.maxTokens)
          .onChange(async (value) => {
            this.plugin.settings.maxTokens = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("LLM Supports Functions")
      .setDesc("Enable or disable LLM support for functions")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.llmSupportsFunctions)
          .onChange(async (value) => {
            this.plugin.settings.llmSupportsFunctions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("LLM Supports Vision")
      .setDesc("Enable or disable LLM support for vision")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.llmSupportsVision)
          .onChange(async (value) => {
            this.plugin.settings.llmSupportsVision = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private updateModelOptions() {
    if (this.modelDropdown) {
      const models = this.getModelsForProvider(this.plugin.settings.provider);
      this.modelDropdown.selectEl.empty();
      Object.entries(models).forEach(([value, name]) => {
        this.modelDropdown?.addOption(value, name);
      });

      if (!models[this.plugin.settings.model]) {
        this.plugin.settings.model = Object.keys(models)[0];
        this.plugin.saveSettings();
      }

      this.modelDropdown.setValue(this.plugin.settings.model);
    }
  }

  private getModelsForProvider(
    provider: "OpenAI" | "Anthropic" | "Groq"
  ): Record<string, string> {
    switch (provider) {
      case "OpenAI":
        return {
          "gpt-4o": "GPT-4o",
          "gpt-4o-mini": "GPT-4o-mini",
        };
      case "Anthropic":
        return {
          "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
          "claude-3-opus-20240229": "Claude 3 Opus",
        };
      case "Groq":
        return {
          "llama-3.1-70b-versatile": "Llama 3.1 70B",
          "llama-3.1-8b-instant": "Llama 3.1 8B",
          "mixtral-8x7b-32768": "Mixtral 8x7B",
        };
      default:
        console.error(`Unknown provider: ${provider}`);
        return {};
    }
  }
}
