# MCP Yeoman Server [![smithery badge](https://smithery.ai/badge/mcp-yeoman)](https://smithery.ai/server/mcp-yeoman)

A Model Context Protocol (MCP) server that provides integration with Yeoman generators, allowing AI agents to search for and run Yeoman templates programmatically.

## Tools

This server implements the following MCP tools:

### Template Search Methods
1. `yeoman_search_templates` - Search for Yeoman templates on npm
   - Parameters:
     - `query` (string): Search keywords separated by commas
     - `pageSize` (number, optional): Number of results to return (default: 20)

### Generator Methods
2. `yeoman_generate` - Run a Yeoman generator
   - Parameters:
     - `generatorName` (string): Name of the generator (without 'generator-' prefix)
     - `options` (object, optional): Options to pass to the generator
     - `cwd` (string): Working directory where the generator should run

## Installation

### Installing via Smithery
To install mcp-yeoman for Claude Desktop automatically via [Smithery](https://smithery.ai/embed/mcp-yeoman):

```bash
npx @smithery/cli@latest install mcp-yeoman --client claude
```

### Prerequisites
- Node.js (v16 or later)
- npm or yarn
- Yeoman environment

### Installing the package
```bash
# Clone the repository
git clone https://github.com/your-username/mcp-yeoman.git
cd mcp-yeoman

# Install dependencies
npm install

# Build the package
npm run build
```

## Usage with Claude Desktop

Add the following to your `claude_desktop_config.json`:

### Using npx
```json
{
  "mcpServers": {
    "yeoman": {
      "command": "npx",
      "args": ["mcp-yeoman"]
    }
  }
}
```

### Direct Node.js
```json
{
  "mcpServers": {
    "yeoman": {
      "command": "node",
      "args": ["/path/to/mcp-yeoman/dist/index.js"]
    }
  }
}
```

Replace `/path/to/mcp-yeoman` with the actual path to your repository.

## Examples

### Search for Templates
```javascript
// Search for React-related templates
const templates = await callTool("yeoman_search_templates", {
  query: "react,typescript",
  pageSize: 10
});
```

### Run a Generator
```javascript
// Run the React generator
const result = await callTool("yeoman_generate", {
  generatorName: "react",
  options: {
    typescript: true,
    sass: true
  },
  cwd: "/path/to/project"
});
```

## Development

```bash
# Install dependencies
npm install

# Start the server in development mode
npm start

# Build the server
npm run build
```

## Error Handling

The server includes comprehensive error handling:
- Validation errors for invalid parameters
- Detailed error logging for debugging
- Automatic cleanup of temporary directories
- Safe error propagation through MCP protocol

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. When contributing, please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request with a clear description of changes
4. Ensure all tests pass and code style is maintained
