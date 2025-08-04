# MCP Yeoman Server 

[![Third Strand Studio](https://img.shields.io/badge/Third%20Strand%20Studio-Visit%20Us-blue)](https://tss.topiray.com) 

[![smithery badge](https://smithery.ai/badge/@thirdstrandstudio/mcp-yeoman)](https://smithery.ai/server/@thirdstrandstudio/mcp-yeoman)

A Model Context Protocol (MCP) server that provides integration with Yeoman generators, allowing AI agents to search for and run Yeoman templates programmatically.


<img width="832" alt="Cursor_CIuNzjl6ca" src="https://github.com/user-attachments/assets/d062eb45-320e-4f4a-8bfa-121bb522b8b7" />


## Tools

This server implements the following MCP tools:

### Template Search Methods
1. `yeoman_search_templates` - Search for Yeoman templates on npm
   - Parameters:
     - `query` (string): Search keywords separated by commas
     - `pageSize` (number, optional): Number of results to return (default: 20)

### Generator Methods
2. `yeoman_get_generator_options` - Get the required options and arguments for a Yeoman generator
   - Parameters:
     - `generatorName` (string): Name of the generator (without 'generator-' prefix)

3. `yeoman_generate` - Run a Yeoman generator
   - Parameters:
     - `generatorName` (string): Name of the generator (without 'generator-' prefix)
     - `cwd` (string): Working directory where the generator should run
     - `appName` (string): The name of the application to create
     - `version` (string): The version of the application to create
     - `options` (object, optional): Options to pass to the generator
     - `args` (array, optional): Additional positional arguments to pass to the generator

## Installation

### Installing via Smithery
To install mcp-yeoman for Claude Desktop automatically via [Smithery](https://smithery.ai/embed/mcp-yeoman):

```bash
npx @smithery/cli@latest install mcp-yeoman --client claude
```

### Prerequisites
- Node.js (v16 or later)
- npm or yarn

### Installing the package
```bash
# Clone the repository
git clone https://github.com/thirdstrandstudio/mcp-yeoman.git
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
      "args": ["@thirdstrandstudio/mcp-yeoman"]
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

## Command-line Arguments

The server supports the following command-line arguments:

- `--generator-dir <path>`: Specify a persistent directory for installing Yeoman generators. By default, generators are installed in a temporary directory that is removed when the operation completes. Using a persistent directory can improve performance for repeated operations with the same generators.

Example:
```json
{
  "mcpServers": {
    "yeoman": {
      "command": "node",
      "args": ["/path/to/mcp-yeoman/dist/index.js", "--generator-dir", "/path/to/generator-storage"]
    }
  }
}
```

## Examples

### Search for Templates
```javascript
// Search for React-related templates
const templates = await callTool("yeoman_search_templates", {
  query: "react,typescript",
  pageSize: 10
});
```

### Get Generator Options
```javascript
// Get options for the React generator
const options = await callTool("yeoman_get_generator_options", {
  generatorName: "react"
});
```

### Run a Generator
```javascript
// Run the React generator
const result = await callTool("yeoman_generate", {
  generatorName: "react",
  cwd: "/path/to/project",
  appName: "my-react-app",
  version: "1.0.0",
  options: {
    typescript: true,
    sass: true
  }
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
- Interactive prompt detection and guidance for required options
- Detailed error logging for debugging
- Automatic cleanup of temporary directories (unless using --generator-dir)
- Safe error propagation through MCP protocol

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. When contributing, please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request with a clear description of changes
4. Ensure all tests pass and code style is maintained
