#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import axios from 'axios';
import execa from 'execa';
import path from 'path';
import fs from 'fs/promises';
import * as fsSync from 'fs';
import os from 'os';
import { spawn } from 'child_process';

// Add configuration for persistent generator directory from command line args
let persistentGeneratorDir: string | null = null;

// Parse command line arguments
function parseCommandLineArgs() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--generator-dir" && i + 1 < args.length) {
            persistentGeneratorDir = args[i + 1];
            i++; // Skip the next argument as it's the value
        }
    }

    if (persistentGeneratorDir) {
        console.log(`Using persistent generator directory: ${persistentGeneratorDir}`);
        // Ensure the directory exists
        try {
            fsSync.mkdirSync(persistentGeneratorDir, { recursive: true });
        } catch (error) {
            console.error(`Failed to create generator directory: ${error}`);
            persistentGeneratorDir = null;
        }
    }
}

const SearchYeomanTemplatesArgumentsSchema = z.object({
    query: z.string().describe("The query to search for seperate with commas if multiple keywords .e.g. react,typescript,tailwind"),
    pageSize: z.number().default(20).describe("The number of templates to return (default 20)")
});

const GetGeneratorOptionsArgumentsSchema = z.object({
    generatorName: z.string().describe("The name of the Yeoman generator to get options for (without the 'generator-' prefix)")
});

const RunYeomanGeneratorArgumentsSchema = z.object({
    generatorName: z.string().describe("The name of the Yeoman generator to run (without the 'generator-' prefix)"),
    options: z.record(z.any()).optional().describe("Options to pass to the generator"),
    cwd: z.string().describe("The working directory where the generator should run"),
    args: z.array(z.string()).optional().describe("Positional arguments to pass to the generator"),
    appName: z.string().describe("The name of the application to create"),
    version: z.string().describe("The version of the application to create"),
});

const responseToString = (response: any) => {
    return {
        content: [{ type: "text", text: JSON.stringify(response) }]
    };
}

// Add a utility function to help with conversion
function convertZodToJsonSchema(schema: z.ZodType<any>) {
    const jsonSchema = zodToJsonSchema(schema);
    return {
        ...jsonSchema
    };
}

// Create server instance
const server = new Server(
    {
        name: "mcp_yeoman",
        version: "0.6.2"
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

const sendLogMessage = (message: string, level: LoggingMessageNotification["params"]["level"] = "info") => {
    console.log({
        message: message,
        level: level
    })
}

// Define an interface for the .yo-rc.json file structure
interface YoRC {
    [key: string]: Record<string, any>;
}

async function searchYeomanTemplates(query: string, pageSize: number) {
    try {
        // Search npm registry for packages with 'yeoman-generator' keyword and your query
        const response = await axios.get('https://registry.npmjs.org/-/v1/search', {
            params: {
                text: `keywords:yeoman-generator,${query.split(' ').join(',')}`,
                size: pageSize
            }
        });

        // Filter results to ensure they're actually Yeoman generators
        const generators = response.data.objects.filter((item: any) =>
            item.package.keywords &&
            item.package.keywords.includes('yeoman-generator')
        );

        return generators.map((item: any) => ({
            name: item.package.name,
            description: item.package.description,
            url: item.package.links.npm,
            version: item.package.version,
            author: item.package.publisher ? item.package.publisher.username : 'Unknown',
            searchScore: item.searchScore,
            downloads: {
                monthly: item.downloads.monthly,
                weekly: item.downloads.weekly,
            },
            license: item.package.license
        }));
    } catch (error) {
        sendLogMessage(`Error searching for Yeoman templates: ${error}`, "error");
        throw error;
    }
}

// Function to get generator directory
async function getGeneratorDir(): Promise<string> {
    // If we have a persistent directory configured, use it
    if (persistentGeneratorDir) {
        return persistentGeneratorDir;
    }
    
    // Otherwise create a temp directory
    const tempDir = await createTempDir();
    return tempDir;
}

async function createTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yeoman-'));
    return tempDir;
}

async function cleanup(tempDir: string) {
    // Only clean up if it's a temporary directory, not our persistent one
    if (persistentGeneratorDir && tempDir === persistentGeneratorDir) {
        return;
    }
    
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
        sendLogMessage(`Error cleaning up temporary directory: ${error}`, "error");
    }
}

// Skip TypeScript checks for dynamic generator key in .yo-rc.json
function getGeneratorKey(generatorName: string): string {
    return `generator-${generatorName}`;
}

// Add this function to capture help output from a generator
async function getGeneratorHelp(generatorName: string, nodeModulesPath: string, cwd: string, customEnv: any) {
    return new Promise<string>((resolve, reject) => {
        const yoPath = path.join(nodeModulesPath, 'yo', 'lib', 'cli.js');
        const helpProcess = spawn('node', [yoPath, generatorName, '--help'], {
            cwd,
            env: customEnv,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let helpOutput = '';
        helpProcess.stdout.on('data', (data) => {
            helpOutput += data.toString();
        });

        helpProcess.stderr.on('data', (data) => {
            sendLogMessage(`Error from help command: ${data}`, "error");
        });

        helpProcess.on('close', (code) => {
            if (code === 0) {
                resolve(helpOutput);
            } else {
                reject(new Error(`Help command exited with code ${code}`));
            }
        });
    });
}

const nonRequiredOptions = ['help', 'skip-cache', 'skip-install', 'force-install', 'ask-answered', 'force', 'yes', 'force-yes', 'quiet', 'no-color', 'no-insight', 'silent'];

// Helper function to parse the generator help output and extract arguments and options
function parseGeneratorHelp(helpOutput: string): {
    args: Array<{ name: string, type: string, required: boolean, description: string }>,
    options: Array<{ name: string, flag: string, description: string, default?: string, required?: boolean }>
} {
    const result = {
        args: [] as Array<{ name: string, type: string, required: boolean, description: string }>,
        options: [] as Array<{ name: string, flag: string, description: string, default?: string, required?: boolean }>
    };

    // Parse the usage line first to understand available arguments
    const usageMatch = helpOutput.match(/Usage:[\s\n]+yo\s+(\w+)\s+([^\n]+)/);
    if (usageMatch) {
        const usageLine = usageMatch[2].trim();
        // Extract arguments from usage line, they're typically in [<argname>] format
        const argMatches = usageLine.match(/\[\<(\w+)\>\]/g);
        if (argMatches) {
            // Create preliminary arg entries that will be enhanced later
            argMatches.forEach(match => {
                const argName = match.replace(/[\[\]<>]/g, '');
                result.args.push({
                    name: argName,
                    type: 'String',
                    required: false,
                    description: ''
                });
            });
        }
    }

    // Parse Arguments section to get more details
    const argsMatch = helpOutput.match(/Arguments:([^]*?)(\n\n|\n$|$)/);
    if (argsMatch) {
        const argsSection = argsMatch[1];
        // Improved regex to handle the format shown in the example
        const argRegex = /\s*(\w+)\s*#\s*([^]*?)(?:\s*Type:\s*(\w+))?(?:\s*Required:\s*(true|false))?(?:\n|$)/g;
        let match;

        while ((match = argRegex.exec(argsSection)) !== null) {
            const [_, name, description, type = 'String', required = 'false'] = match;

            // Check if this arg is already in our list
            const existingArgIndex = result.args.findIndex(a => a.name === name);
            if (existingArgIndex >= 0) {
                // Update existing arg with more info
                result.args[existingArgIndex] = {
                    name,
                    type: type || 'String',
                    required: required === 'true',
                    description: description.trim()
                };
            } else {
                // Add as new arg
                result.args.push({
                    name,
                    type: type || 'String',
                    required: required === 'true',
                    description: description.trim()
                });
            }
        }
    }

    // Parse Options section
    const optionsMatch = helpOutput.match(/Options:([^]*?)(\n\nArguments:|\n\n|\n$|$)/);
    if (optionsMatch) {
        const optionsSection = optionsMatch[1];
        // Improved regex to handle the format shown in the example
        const optionRegex = /\s*(?:-(\w),)?\s*--(\S+)\s*#\s*([^]*?)(?:\s*Default:\s*(\S+))?(?:\n|$)/g;
        let match;

        while ((match = optionRegex.exec(optionsSection)) !== null) {
            const [_, shortFlag, name, description, defaultValue] = match;


            // Look for indicators that the option is required in the description
            let isRequired =
                description.includes('(Required)') ||
                description.includes('[Required]') ||
                description.includes('required') ||
                !description.includes('Optional');

            if (nonRequiredOptions.includes(name)) {
                isRequired = false;
            }

            result.options.push({
                name,
                flag: shortFlag || '',
                description: description.trim(),
                default: defaultValue,
                required: isRequired
            });
        }
    }

    // Look for prompt sections in the help text which indicates interactive options
    // Some generators list their prompts at the bottom of the help
    const promptMatch = helpOutput.match(/(?:Questions|Prompts|Inputs):(.*?)(?:\n\n|\n$|$)/is);
    if (promptMatch) {
        const promptSection = promptMatch[1];
        // Try to extract option names from the prompt section and mark them as required
        // This is an additional heuristic
        result.options.forEach(option => {
            if (nonRequiredOptions.includes(option.name)) {
                option.required = false;
            } else if (promptSection.includes(option.name)) {
                option.required = true;
            }
        });
    }

    return result;
}

// Function to extract enum values from option descriptions
function extractEnumValues(description: string): string[] | null {
    // Look for patterns like [value1|value2|value3] in the description
    const match = description.match(/\[([^\]]+)\]/);
    if (match) {
        // Split by pipe character to get individual enum values
        return match[1].split('|');
    }
    return null;
}

// Function to determine if an option is required (no default value)
function isOptionRequired(option: { name: string, description: string, default?: string, required?: boolean }): boolean {
    // If explicitly marked as required in the help text
    if (option.required === true) {
        return true;
    }

    // If it has a default value, it's not required
    if (option.default !== undefined) {
        return false;
    }

    // Check for Default: in the description
    if (option.description.includes('Default:')) {
        return false;
    }

    if (nonRequiredOptions.includes(option.name)) {
        return false;
    }

    // Check if the option name suggests it might be required
    const likelyRequiredOptionPatterns = ['username', 'name', 'email', 'author', 'css', 'style', 'client', 'graphql'];
    for (const pattern of likelyRequiredOptionPatterns) {
        if (option.name.toLowerCase().includes(pattern)) {
            return true;
        }
    }

    // Look for prompts that might be in the option description
    if (option.description.includes('?') ||
        option.description.match(/\b(enter|specify|provide)\b/i)) {
        return true;
    }

    // Consider all remaining options that have enum values as required
    const enumValues = extractEnumValues(option.description);
    if (enumValues && enumValues.length > 0) {
        return true;
    }

    // Default behavior - if we can't determine for sure, assume it's optional
    return false;
}

// Function to check if all required arguments are provided
function checkRequiredArguments(
    helpInfo: ReturnType<typeof parseGeneratorHelp>,
    providedArgs: string[],
    providedOptions: Record<string, any>
): {
    missingRequired: Array<{ name: string, description: string }>,
    missingOptions: Array<{ name: string, description: string, enumValues: string[] | null }>,
    defaultOptions: Record<string, any>
} {
    const result = {
        missingRequired: [] as Array<{ name: string, description: string }>,
        missingOptions: [] as Array<{ name: string, description: string, enumValues: string[] | null }>,
        defaultOptions: {} as Record<string, any>
    };

    // Check required arguments
    helpInfo.args.forEach((arg, index) => {
        if (arg.required && (providedArgs.length <= index)) {
            result.missingRequired.push({
                name: arg.name,
                description: arg.description
            });
        }
    });

    // Check for required options without default values
    helpInfo.options.forEach(option => {
        const kebabName = option.name;
        const camelName = kebabName.replace(/-([a-z])/g, g => g[1].toUpperCase());

        // Check if option is required
        const isRequired = isOptionRequired(option);

        // Extract enum values for informational purposes
        const enumValues = extractEnumValues(option.description);

        // If option has enum values and is not provided, automatically use first value
        if (enumValues && enumValues.length > 0 &&
            !providedOptions[kebabName] && !providedOptions[camelName]) {

            // Only add to missing options if it seems required
            if (isRequired) {
                result.missingOptions.push({
                    name: kebabName,
                    description: option.description,
                    enumValues
                });
            }
        }
        // If any other required option is missing
        else if (isRequired && !providedOptions[kebabName] && !providedOptions[camelName]) {
            result.missingOptions.push({
                name: kebabName,
                description: option.description,
                enumValues: null
            });
        }
    });

    return result;
}


// Update runYeomanGenerator to use persistent directory
async function runYeomanGenerator(generatorName: string, options: any = {}, cwd: string, args: string[] = []) {
    // Get or create directory for generators
    const genDir = await getGeneratorDir();
    const shouldCleanup = !persistentGeneratorDir || genDir !== persistentGeneratorDir;

    try {
        // Ensure the target directory exists
        await fs.mkdir(cwd, { recursive: true });

        // Create a package.json file in the generator directory if it doesn't exist
        const packageJsonPath = path.join(genDir, 'package.json');
        if (!fsSync.existsSync(packageJsonPath)) {
            await fs.writeFile(packageJsonPath, JSON.stringify({
                name: 'yeoman-temp',
                version: '1.0.0',
                private: true
            }));
        }

        // Check if generator is already installed
        const generatorPath = path.join(genDir, 'node_modules', `generator-${generatorName}`);
        const yoPath = path.join(genDir, 'node_modules', 'yo');
        const needsInstall = !fsSync.existsSync(generatorPath) || !fsSync.existsSync(yoPath);

        // Only install generators if they're not already installed
        if (needsInstall) {
            sendLogMessage(`Installing yo and generator-${generatorName}...`);
            try {
                await execa('npm', ['install', 'yo', `generator-${generatorName}`], { cwd: genDir });
                sendLogMessage(`Successfully installed yo and generator-${generatorName}`);
            } catch (installError: any) {
                sendLogMessage(`Error installing generator: ${installError.message}`, "error");
                return {
                    success: false,
                    error: `Failed to install generator-${generatorName}: ${installError.message}`,
                    suggestions: [`Make sure generator-${generatorName} exists on npm`]
                };
            }
        } else {
            sendLogMessage(`Using previously installed generator-${generatorName}`);
        }

        const nodeModulesPath = path.join(genDir, 'node_modules');

        // Create a custom environment with updated PATH to find the installed modules
        const PATH_ENV_VAR = process.platform === 'win32' ? 'Path' : 'PATH';
        const customEnv = {
            ...process.env,
            [PATH_ENV_VAR]: `${nodeModulesPath}/.bin${path.delimiter}${process.env[PATH_ENV_VAR]}`,
            NODE_PATH: nodeModulesPath,
            CI: 'true', // Set CI=true to avoid interactive prompts
            YEOMAN_SKIP_PROMPTS: 'true', // Try to skip prompts as much as possible
            FORCE_COLOR: 'false', // Disable colors
            YEOMAN_SKIP_INSTALL: 'true', // Skip npm/yarn install steps
            INQUIRER_SKIP_PROMPTS: 'true', // Skip inquirer prompts
            SKIP_PROMPTS: 'true', // Generic skip prompts flag
            YO_RUN_NONINTERACTIVELY: 'true', // Another way to try forcing non-interactive mode
            CI_YEOMAN: 'true' // Another indicator for CI mode
        };

        // Get help information about the generator
        let helpInfo = null;
        let helpOutput = '';

        try {
            const helpOutputResult = await getGeneratorHelp(generatorName, nodeModulesPath, genDir, customEnv);
            helpOutput = helpOutputResult;
            helpInfo = parseGeneratorHelp(helpOutput);

            // Check if we're missing required arguments and options
            const { missingRequired, missingOptions } = checkRequiredArguments(helpInfo, args, options);

            // If we have missing required arguments, return error
            if (missingRequired.length > 0) {
                return {
                    success: false,
                    error: 'Missing required arguments',
                    missingRequired,
                    usage: extractUsageFromHelp(helpOutput),
                    suggestions: missingRequired.map(arg =>
                        `Please provide a value for "${arg.name}": ${arg.description || 'no description available'}`
                    )
                };
            }

            // If we have missing options, return error with suggestions
            if (missingOptions.length > 0) {
                // Format suggestions with better information
                const suggestions = missingOptions.map(opt => {
                    if (opt.enumValues && opt.enumValues.length > 0) {
                        return `--${opt.name}: ${opt.description}. Valid values: [${opt.enumValues.join(', ')}]`;
                    }
                    return `--${opt.name}: ${opt.description}`;
                });

                // Create a formatted command example with all required options
                const optionExamples = missingOptions.map(opt => {
                    if (opt.enumValues && opt.enumValues.length > 0) {
                        return `--${opt.name}=${opt.enumValues[0]}`;
                    }
                    return `--${opt.name}="value"`;
                }).join(' ');

                const argsExample = args.length > 0 ? args.join(' ') : (helpInfo?.args.length ? '<appname>' : '');
                const commandExample = `yo ${generatorName} ${argsExample} ${optionExamples}`;

                return {
                    success: false,
                    error: 'Missing required options',
                    missingOptions,
                    usage: extractUsageFromHelp(helpOutput),
                    suggestions,
                    commandExample
                };
            }

        } catch (helpError: any) {
            sendLogMessage(`Error getting generator help: ${helpError.message}`, "error");
            // We'll continue without help information - the generator might still work
        }

        // If the generator requires arguments according to help, ensure they're provided
        if (helpInfo && helpInfo.args.some(arg => arg.required) && args.length === 0) {
            const requiredArgs = helpInfo.args.filter(arg => arg.required);
            return {
                success: false,
                error: 'Required arguments missing',
                missingRequired: requiredArgs,
                usage: helpInfo ? formatArgsUsage(helpInfo.args) : null,
                suggestions: [
                    `This generator requires arguments: ${requiredArgs.map(a => a.name).join(', ')}`,
                    `Example usage: generator ${generatorName} ${requiredArgs.map(a => `<${a.name}>`).join(' ')}`
                ]
            };
        }

        // Log the options that will be used
        sendLogMessage('Using options:', options);

        // Run the generator with the provided options and arguments
        sendLogMessage(`Running generator-${generatorName}...`);

        // Create the command parts - add force-non-interactive flags
        const cliYoPath = path.join(nodeModulesPath, 'yo', 'lib', 'cli.js');
        const yoArgs = [cliYoPath, generatorName, ...args];

        // Add options as command line arguments
        for (const [key, value] of Object.entries(options)) {
            if (value === true) {
                yoArgs.push(`--${key}`);
            } else if (value !== false && value !== undefined && value !== null) {
                yoArgs.push(`--${key}=${value}`);
            }
        }

        // Add flags to make it non-interactive
        const nonInteractiveFlags = [
            '--no-insight',
            '--no-color',
            '--force-yes',
            '--yes',
            '--skip-install',
            '--skip-cache',
            '--skip-prompts',
            '--quiet',
            '--no-interactive'
        ];
        nonInteractiveFlags.forEach(flag => {
            if (!yoArgs.includes(flag)) {
                yoArgs.push(flag);
            }
        });

        try {
            // Run the generator as a child process
            const result = await new Promise<{ success: boolean, output: string }>((resolve, reject) => {
                // Create a null input stream to avoid waiting for user input
                let nullInput: number | 'ignore';
                try {
                    // On Windows, we need to use 'NUL' (case-insensitive)
                    if (process.platform === 'win32') {
                        nullInput = fsSync.openSync('\\\\.\\NUL', 'r');
                    } else {
                        nullInput = fsSync.openSync('/dev/null', 'r');
                    }
                } catch (error) {
                    // If we can't open a null device, fall back to ignore
                    console.warn('Could not open null device, falling back to ignore:', error);
                    nullInput = 'ignore';
                }

                const stdio: [typeof nullInput, 'pipe', 'pipe'] = [nullInput, 'pipe', 'pipe'];
                const yoProcess = spawn('node', yoArgs, {
                    cwd,
                    env: customEnv,
                    stdio
                });

                let output = '';

                if (yoProcess.stdout) {
                    yoProcess.stdout.on('data', (data: Buffer) => {
                        const chunk = data.toString();
                        output += chunk;
                    });
                }

                if (yoProcess.stderr) {
                    yoProcess.stderr.on('data', (data: Buffer) => {
                        const chunk = data.toString();
                        output += chunk;
                        sendLogMessage(chunk, "error");
                    });
                }

                yoProcess.on('close', (code: number | null) => {
                    // Close the null input file descriptor if it's a number (file descriptor)
                    if (typeof nullInput === 'number') {
                        try {
                            fsSync.closeSync(nullInput);
                        } catch (error) {
                            sendLogMessage(`Error closing null device: ${error}`, "error");
                        }
                    }

                    if (code === 0) {
                        resolve({ success: true, output });
                    } else {
                        resolve({
                            success: false,
                            output
                        });
                    }
                });

                yoProcess.on('error', (error: Error) => {
                    // Close the null input file descriptor if it's a number (file descriptor)
                    if (typeof nullInput === 'number') {
                        try {
                            fsSync.closeSync(nullInput);
                        } catch (closeError) {
                            sendLogMessage(`Error closing null device: ${closeError}`, "error");
                        }
                    }
                    reject(error);
                });
            });

            // Check for various error conditions in the output
            if (result.output.includes('Did not find a suitable generator')) {
                return {
                    success: false,
                    error: `Generator '${generatorName}' not found`,
                    output: cleanOutput(result.output),
                    suggestions: [`Make sure generator-${generatorName} exists on npm`]
                };
            }

            // Check if the output contains prompts, which indicates missing required options
            if (result.output.includes('?') &&
                (result.output.match(/\?\s+[\w\s]+/g) || // Matches "? Some prompt"
                    result.output.match(/>\s+[\w\s]+/g))) { // Matches "> Some option"

                // Extract the prompts from the output
                const questionPrompts = result.output.match(/\?\s+[\w\s]+[^\n]*/g) || [];
                const optionPrompts = result.output.match(/>\s+[\w\s]+[^\n]*/g) || [];
                const promptLines = [...questionPrompts, ...optionPrompts].map(line => line.trim());

                // Construct a helpful error message
                return {
                    success: false,
                    error: 'Generator entered interactive mode - missing required options',
                    output: cleanOutput(result.output),
                    promptsDetected: promptLines,
                    suggestions: [
                        'The generator is trying to prompt for input. Please provide all required options:',
                        ...promptLines.map(line => `- ${line}`),
                        'Run with --help to see all available options',
                    ]
                };
            }

            if (result.output.includes('Invalid version format')) {
                return {
                    success: false,
                    error: 'Invalid version format provided',
                    output: cleanOutput(result.output),
                    suggestions: [
                        'Version should follow semantic versioning (e.g., "1.0.0")',
                        'Make sure your arguments are in the correct order'
                    ]
                };
            }

            if (!result.success) {
                return {
                    success: false,
                    error: 'Generator failed to run successfully',
                    output: cleanOutput(result.output),
                };
            }

            // Check if .yo-rc.json was created to verify generator ran
            const yoRcPath = path.join(cwd, '.yo-rc.json');
            let generatorConfigExists = false;

            if (fsSync.existsSync(yoRcPath)) {
                try {
                    const yoRcContent = await fs.readFile(yoRcPath, 'utf8');
                    const yoRc = JSON.parse(yoRcContent) as YoRC;

                    // Check if the generator config exists in the .yo-rc.json file
                    const generatorKey = getGeneratorKey(generatorName);
                    generatorConfigExists = !!yoRc[generatorKey];
                } catch (e) {
                    sendLogMessage(`Error reading .yo-rc.json: ${e}`, "error");
                }
            }

            // Return success result with cleaned output
            return {
                success: true,
                output: cleanOutput(result.output),
                generatorRan: true,
                generatorConfigExists
            };

        } catch (runError: any) {
            sendLogMessage(`Error running generator: ${runError.message}`, "error");
            return {
                success: false,
                error: `Failed to run generator: ${runError.message}`,
            };
        }

    } catch (error: any) {
        sendLogMessage(`Unexpected error: ${error.message}`, "error");
        return {
            success: false,
            error: `Unexpected error: ${error.message}`
        };
    } finally {
        // Only clean up if it's a temporary directory
        if (shouldCleanup) {
            await cleanup(genDir);
        }
    }
}

// Helper function to extract usage from help output
function extractUsageFromHelp(helpOutput: string): string | null {
    const usageMatch = helpOutput.match(/Usage:([^\n]*(?:\n[^\n]*)*?)(?:\n\n|\n$)/);
    return usageMatch ? usageMatch[1].trim() : null;
}

// Format arguments for usage display
function formatArgsUsage(args: Array<{ name: string, required: boolean }>): string {
    return args.map(arg => {
        const brackets = arg.required ? '<>' : '[]';
        return `${brackets[0]}${arg.name}${brackets[1]}`;
    }).join(' ');
}

// Clean the console output for better readability in JSON response
function cleanOutput(output: string): string {
    // Remove ANSI color codes and other control characters
    return output
        .replace(/\u001b\[\d+m/g, '')     // Remove color codes
        .replace(/\u001b\[\?25[hl]/g, '') // Remove cursor visibility commands
        .replace(/\u001b\[\d+[A-Z]/g, '') // Remove cursor movement commands
        .replace(/\r\n/g, '\n')           // Normalize line endings
        .replace(/\r/g, '\n')             // Replace carriage returns
        .replace(/\n{3,}/g, '\n\n');      // Collapse multiple newlines
}

// Update getGeneratorOptions to use persistent directory
async function getGeneratorOptions(generatorName: string) {
    // Get or create directory for generators
    const genDir = await getGeneratorDir();
    const shouldCleanup = !persistentGeneratorDir || genDir !== persistentGeneratorDir;

    try {
        // Create a package.json file in the generator directory if it doesn't exist
        const packageJsonPath = path.join(genDir, 'package.json');
        if (!fsSync.existsSync(packageJsonPath)) {
            await fs.writeFile(packageJsonPath, JSON.stringify({
                name: 'yeoman-temp',
                version: '1.0.0',
                private: true
            }));
        }

        // Check if generator is already installed
        const generatorPath = path.join(genDir, 'node_modules', `generator-${generatorName}`);
        const yoPath = path.join(genDir, 'node_modules', 'yo');
        const needsInstall = !fsSync.existsSync(generatorPath) || !fsSync.existsSync(yoPath);

        // Only install generators if they're not already installed
        if (needsInstall) {
            sendLogMessage(`Installing yo and generator-${generatorName}...`);
            try {
                await execa('npm', ['install', 'yo', `generator-${generatorName}`], { cwd: genDir });
                sendLogMessage(`Successfully installed yo and generator-${generatorName}`);
            } catch (installError: any) {
                sendLogMessage(`Error installing generator: ${installError.message}`, "error");
                return {
                    success: false,
                    error: `Failed to install generator-${generatorName}: ${installError.message}`,
                    suggestions: [`Make sure generator-${generatorName} exists on npm`]
                };
            }
        } else {
            sendLogMessage(`Using previously installed generator-${generatorName}`);
        }

        const nodeModulesPath = path.join(genDir, 'node_modules');

        // Create a custom environment with updated PATH to find the installed modules
        const PATH_ENV_VAR = process.platform === 'win32' ? 'Path' : 'PATH';
        const customEnv = {
            ...process.env,
            [PATH_ENV_VAR]: `${nodeModulesPath}/.bin${path.delimiter}${process.env[PATH_ENV_VAR]}`,
            NODE_PATH: nodeModulesPath
        };

        // Get help information about the generator
        let helpOutput = '';

        try {
            helpOutput = await getGeneratorHelp(generatorName, nodeModulesPath, genDir, customEnv);
            const helpInfo = parseGeneratorHelp(helpOutput);
            
            // Format options and arguments in a more descriptive way
            const formattedArgs = helpInfo.args.map(arg => ({
                name: arg.name,
                type: arg.type,
                required: arg.required,
                description: arg.description
            }));
            
            const formattedOptions = helpInfo.options.map(opt => {
                const enumValues = extractEnumValues(opt.description);
                return {
                    name: opt.name,
                    flag: opt.flag,
                    description: opt.description,
                    default: opt.default,
                    required: isOptionRequired(opt),
                    enumValues: enumValues
                };
            });
            
            return {
                success: true,
                usage: extractUsageFromHelp(helpOutput),
                args: formattedArgs,
                options: formattedOptions,
                suggestedCommand: generateSuggestedCommand(generatorName, formattedArgs, formattedOptions)
            };
        } catch (helpError: any) {
            sendLogMessage(`Error getting generator help: ${helpError.message}`, "error");
            return {
                success: false,
                error: `Failed to get generator options: ${helpError.message}`
            };
        }
    } catch (error: any) {
        sendLogMessage(`Unexpected error: ${error.message}`, "error");
        return {
            success: false,
            error: `Unexpected error: ${error.message}`
        };
    } finally {
        // Only clean up if it's a temporary directory
        if (shouldCleanup) {
            await cleanup(genDir);
        }
    }
}

// Helper function to generate a suggested command with required parameters
function generateSuggestedCommand(
    generatorName: string, 
    args: Array<{name: string, required: boolean}>,
    options: Array<{name: string, required: boolean, enumValues: string[] | null}>
): string {
    const requiredArgs = args
        .filter(arg => arg.required)
        .map(arg => `<${arg.name}>`);
        
    const requiredOptions = options
        .filter(opt => opt.required)
        .map(opt => {
            if (opt.enumValues && opt.enumValues.length > 0) {
                return `--${opt.name}=${opt.enumValues[0]}`;
            }
            return `--${opt.name}="value"`;
        });
        
    return `yo ${generatorName} ${requiredArgs.join(' ')} ${requiredOptions.join(' ')}`.trim();
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "yeoman_search_templates",
                description: "Search for Yeoman templates",
                inputSchema: convertZodToJsonSchema(SearchYeomanTemplatesArgumentsSchema),
            },
            {
                name: "yeoman_get_generator_options",
                description: "Get the required options and arguments for a Yeoman generator",
                inputSchema: convertZodToJsonSchema(GetGeneratorOptionsArgumentsSchema),
            },
            {
                name: "yeoman_generate",
                description: "Run a Yeoman generator",
                inputSchema: convertZodToJsonSchema(RunYeomanGeneratorArgumentsSchema),
            }
        ]
    };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "yeoman_search_templates":
                const { query, pageSize } = SearchYeomanTemplatesArgumentsSchema.parse(args);
                const templates = await searchYeomanTemplates(query, pageSize);
                return responseToString(templates);

            case "yeoman_get_generator_options":
                const { generatorName: genName } = GetGeneratorOptionsArgumentsSchema.parse(args);
                const generatorOptions = await getGeneratorOptions(genName);
                return responseToString(generatorOptions);

            case "yeoman_generate":
                const {
                    generatorName,
                    options = {},
                    cwd,
                    appName,
                    version,
                    args: positionalArgs = [],
                } = RunYeomanGeneratorArgumentsSchema.parse(args);

                // Add common non-interactive flags to options
                const mergedOptions = {
                    ...options,
                    // Add non-interactive flags - these don't affect functionality, just UX
                    'skip-install': true,
                    'skip-cache': true,
                    'force-yes': true,
                    'yes': true,
                    'no-insight': true,
                    'no-color': true,
                    'quiet': true
                };

                // Build positional arguments array
                const allPositionalArgs: string[] = [...positionalArgs];


                if (version) {
                    allPositionalArgs.unshift(version);
                }

                if (appName) {
                    allPositionalArgs.unshift(appName);
                }


                try {
                    const result = await runYeomanGenerator(generatorName, mergedOptions, cwd, allPositionalArgs);
                    return responseToString(result);
                } catch (error: any) {
                    sendLogMessage(`Error running generator: ${error}`);
                    throw error;
                }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof z.ZodError) {
            throw new Error(
                `Invalid arguments: ${error.errors
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join(", ")}`
            );
        }

        // Add detailed error logging
        const err = error as any;
        sendLogMessage(`Error details: ${JSON.stringify({
            message: err.message,
            stack: err.stack,
            response: err.response?.data || null,
            status: err.response?.status || null,
            headers: err.response?.headers || null,
            name: err.name,
            fullError: JSON.stringify(err, Object.getOwnPropertyNames(err), 2)
        })}`, "error");

        throw new Error(`Error executing tool ${name}: ${err.message}${err.response?.data ? ` - Response: ${JSON.stringify(err.response.data)}` : ''}`);
    }
});

// Update main function to parse command line args
async function main() {
    try {
        // Parse command line arguments before starting the server
        parseCommandLineArgs();
        
        console.log("Starting MCP Yeoman Server...");
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.log("MCP Yeoman Server running on stdio");
    } catch (error) {
        console.error(`Error during startup: ${error}`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`Fatal error in main(): ${error}`);
    process.exit(1);
});