#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import axios from 'axios';
import { createEnv } from 'yeoman-environment';
import execa from 'execa';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const SearchYeomanTemplatesArgumentsSchema = z.object({
    query: z.string().describe("The query to search for seperate with commas if multiple keywords .e.g. react,typescript,tailwind"),
    pageSize: z.number().default(20).describe("The number of templates to return (default 20)")
});


const RunYeomanGeneratorArgumentsSchema = z.object({
    generatorName: z.string().describe("The name of the Yeoman generator to run (without the 'generator-' prefix)"),
    options: z.record(z.any()).optional().describe("Options to pass to the generator"),
    cwd: z.string().describe("The working directory where the generator should run")
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

async function searchYeomanTemplates(query: string, pageSize: number) {
    try {
      // Search npm registry for packages with 'yeoman-generator' keyword and your query
      const response = await axios.get('https://registry.npmjs.org/-/v1/search', {
        params: {
          text: `keywords:yeoman-generator,${query}`,
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
      console.error('Error searching for Yeoman templates:', error);
      throw error;
    }
  }
  
async function createTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yeoman-'));
    return tempDir;
}

async function cleanup(tempDir: string) {
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
        console.error('Error cleaning up temporary directory:', error);
    }
}

async function runYeomanGenerator(generatorName: string, options: any = {}, cwd: string) {
    let tempDir = '';
    try {
        // Create temporary directory for generator installation
        tempDir = await createTempDir();
        console.log(`Created temporary directory: ${tempDir}`);

        // Create a package.json in the temp directory
        await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({
            name: 'temp-generator-install',
            version: '1.0.0',
            private: true
        }));

        // Install the generator locally in the temp directory
        console.log(`Installing generator ${generatorName}...`);
        await execa('npm', ['install', `generator-${generatorName}`], {
            stdio: 'inherit',
            cwd: tempDir
        });

        // Create Yeoman environment
        const env = createEnv();
        
        // Set the working directory for generator output
        process.chdir(cwd);

        // Look up for generators in the temp directory
        await env.lookup({
            packagePaths: [tempDir],
            npmPaths: [tempDir]
        });

        // Run the generator
        console.log(`Running generator ${generatorName}...`);
        const result = await env.run([generatorName], options);
        
        return {
            success: true,
            message: `Successfully ran generator ${generatorName}`,
            result
        };
    } catch (error: any) {
        console.error('Error running Yeoman generator:', error);
        throw new Error(`Failed to run generator ${generatorName}: ${error.message}`);
    } finally {
        // Clean up the temporary directory
        if (tempDir) {
            console.log(`Cleaning up temporary directory: ${tempDir}`);
            await cleanup(tempDir);
        }
    }
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

            case "yeoman_generate":
                const { generatorName, options, cwd } = RunYeomanGeneratorArgumentsSchema.parse(args);
                const result = await runYeomanGenerator(generatorName, options, cwd);
                return responseToString(result);

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
        console.error("Error details:", {
            message: err.message,
            stack: err.stack,
            response: err.response?.data || null,
            status: err.response?.status || null,
            headers: err.response?.headers || null,
            name: err.name,
            fullError: JSON.stringify(err, Object.getOwnPropertyNames(err), 2)
        });
        
        throw new Error(`Error executing tool ${name}: ${err.message}${err.response?.data ? ` - Response: ${JSON.stringify(err.response.data)}` : ''}`);
    }
});

// Start the server
async function main() {
    try {
        console.log("Starting MCP Yeoman Server...");
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.log("MCP Yeoman Server running on stdio");
    } catch (error) {
        console.log("Error during startup:", error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.log("Fatal error in main():", error);
    process.exit(1);
});
