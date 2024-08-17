import {
  Plugin,
  Notice,
  Modal,
  App,
  TFolder,
  Setting,
  PluginSettingTab,
  Platform,
} from "obsidian";
import { exec, ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

interface OpenInterpreterSettings {
  apiKey: string;
}

const DEFAULT_SETTINGS: OpenInterpreterSettings = {
  apiKey: "",
};

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

    contentEl.createEl("h1", { text: "Enter command for Open Interpreter" });

    new Setting(contentEl).setName("Command").addText((text) =>
      text.onChange((value) => {
        this.result = value;
      })
    );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Submit")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit(this.result);
        })
    );
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

  constructor(app: App, interpreter: ChildProcess) {
    super(app);
    this.interpreter = interpreter;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Open Interpreter Chat" });

    this.outputEl = contentEl.createEl("div", { cls: "interpreter-output" });
    this.outputEl.style.height = "400px";
    this.outputEl.style.overflowY = "scroll";
    this.outputEl.style.border = "1px solid #ccc";
    this.outputEl.style.padding = "10px";
    this.outputEl.style.marginBottom = "10px";

    this.createInputArea();
    this.createYesNoButtons();

    const sendButton = contentEl.createEl("button", { text: "Send" });
    sendButton.onclick = () => this.sendMessage();

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
    // Split the text into smaller chunks if it's very long
    const chunks = text.match(/.{1,1000}/g) || [];

    chunks.forEach((chunk) => {
      const p = this.outputEl.createEl("p");
      p.textContent = chunk;
      if (isError) {
        p.style.color = "red";
      }
    });

    // Scroll to the bottom
    this.outputEl.scrollTop = this.outputEl.scrollHeight;

    // Check for the code execution prompt
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
    this.showInputArea(); // Reset to input area after sending
  }

  private createInputArea() {
    this.inputEl = this.contentEl.createEl("textarea", {
      cls: "interpreter-input",
    });
    this.inputEl.style.width = "100%";
    this.inputEl.style.height = "100px";
    this.inputEl.style.display = "block";
  }

  private createYesNoButtons() {
    this.buttonContainer = this.contentEl.createEl("div", {
      cls: "yes-no-buttons",
    });
    this.buttonContainer.style.display = "flex";
    this.buttonContainer.style.justifyContent = "space-between";
    this.buttonContainer.style.marginTop = "10px";

    this.yesButton = this.buttonContainer.createEl("button", { text: "Yes" });
    this.yesButton.style.backgroundColor = "#e6ffe6"; // faint green
    this.yesButton.style.color = "#006600";
    this.yesButton.style.border = "1px solid #006600";
    this.yesButton.style.padding = "10px 20px";
    this.yesButton.style.borderRadius = "5px";
    this.yesButton.style.cursor = "pointer";

    this.noButton = this.buttonContainer.createEl("button", { text: "No" });
    this.noButton.style.backgroundColor = "#ffe6e6"; // faint red
    this.noButton.style.color = "#660000";
    this.noButton.style.border = "1px solid #660000";
    this.noButton.style.padding = "10px 20px";
    this.noButton.style.borderRadius = "5px";
    this.noButton.style.cursor = "pointer";

    this.yesButton.onclick = () => this.sendMessage("y");
    this.noButton.onclick = () => this.sendMessage("n");

    this.buttonContainer.style.display = "none";
  }

  private showInputArea() {
    this.inputEl.style.display = "block";
    this.buttonContainer.style.display = "none";
  }

  private showYesNoButtons() {
    this.inputEl.style.display = "none";
    this.buttonContainer.style.display = "block";
  }
}

export default class OpenInterpreterPlugin extends Plugin {
  settings!: OpenInterpreterSettings;
  private interpreterInstalled: boolean = false;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new OpenInterpreterSettingTab(this.app, this));

    this.addCommand({
      id: "run-interpreter",
      name: "Enter Command",
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

  private async getInterpreterProfilePath(): Promise<string> {
    const homedir = os.homedir();
    const profileDir = path.join(
      homedir,
      "Library",
      "Application Support",
      "open-interpreter",
      "profiles"
    );
    const profilePath = path.join(profileDir, "obsidian.py");

    // Ensure the directory exists
    await fs.mkdir(profileDir, { recursive: true });

    // Create an empty profile file if it doesn't exist
    if (!(await fs.stat(profilePath).catch(() => false))) {
      await fs.writeFile(
        profilePath,
        "# Obsidian profile for Open Interpreter\n"
      );
    }

    return profilePath;
  }

  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter && "basePath" in adapter) {
      return (adapter as any).basePath;
    }
    // Fallback to the previous method if basePath is not available
    const rootFolder = this.app.vault.getRoot();
    if (rootFolder instanceof TFolder) {
      return rootFolder.path;
    }
    console.error("Could not determine vault path");
    return null;
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
    const profilePath = await this.getInterpreterProfilePath();
    const vaultPath = this.getVaultPath();

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

    const env = { ...process.env, OPENAI_API_KEY: this.settings.apiKey };

    // Escape the profile path for shell usage
    const escapedProfilePath = profilePath.replace(/'/g, "'\\''");

    const child = spawn(
      interpreterPath,
      ["--profile", `'${escapedProfilePath}'`],
      {
        cwd: vaultPath,
        env: env,
        shell: true,
      }
    );

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
          // Fallback to common paths
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
            : ["C:\\Python\\Scripts\\interpreter.exe"]; // Windows fallback

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

  constructor(app: App, plugin: OpenInterpreterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Open Interpreter Settings" });

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Enter your OpenAI API key")
      .addText((text) =>
        text
          .setPlaceholder("Enter your api key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
