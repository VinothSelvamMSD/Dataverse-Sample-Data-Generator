# Dataverse Sample Data Generator

Generate realistic sample data for any **Microsoft Dataverse** environment — directly from VS Code.

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/vinothselvam.dataverse-sample-data-generator)

## Features

### 🚀 Generate Mode
- **AI-powered data generation** using GitHub Copilot LLM for realistic, context-aware records
- **Faker.js fallback** when LLM is unavailable — always works
- **Multi-table support** with automatic dependency resolution (topological sort)
- **Relationship handling** — automatically links records via lookups using `@odata.bind`
- **Business context** — describe your scenario (e.g., "Healthcare clinic in Singapore") for domain-specific data
- **Column filtering** — Best Applicable, Only Mandatory, or hand-pick specific columns
- **Batch writes** using Dataverse `$batch` API for efficient bulk inserts

### 🧹 Cleanup Mode
- **Safe deletion** with reverse topological sort (children deleted before parents)
- **Sort order** — delete newest or oldest records first
- **FetchXML filter** — advanced record targeting with custom FetchXML queries
- **Deletion plan preview** — review before executing irreversible deletes
- **Batch DELETE** in chunks of 50 with individual fallback

### 💬 GitHub Copilot Integration
- **Chat Participant** (`@dvdata`) — generate data through natural language in Copilot Chat
- **Language Model Tool** — other Copilot agents can invoke data generation programmatically
- Commands: `/connect`, `/tables`, `/plan`, `/generate`, `/cleanup`

### 🔐 Authentication
- **Browser Sign-in** (recommended) — supports MFA, SSO, federation via PKCE
- **Device Code** flow — for restricted environments

## Getting Started

1. Install the extension from VS Code Marketplace
2. Open Command Palette → **Dataverse Sample Data: Open Generator UI**
3. Enter your Dataverse environment URL (e.g., `https://yourorg.crm.dynamics.com`)
4. Click **Connect** and sign in via browser
5. Select tables, configure record counts, and click **Generate**

## Using with Copilot Chat

Open GitHub Copilot Chat and type:

```
@dvdata /connect https://yourorg.crm.dynamics.com
@dvdata /generate account, contact — 50 records each for a healthcare clinic
@dvdata /cleanup account — delete the 50 newest records
```

## Screenshots

### Generator UI
The webview provides a step-by-step workflow:
1. **Connect** to your Dataverse environment
2. **Select tables** to populate
3. **Configure** record counts, column mode, and business context per table
4. **Generate** — watch real-time progress as records are created
5. **Review results** — see counts, data source (AI/Faker), and any errors

### Cleanup Mode
Switch to Cleanup mode to safely remove records:
1. **Select tables** to clean
2. **Configure** deletion count, sort order, and optional FetchXML filter
3. **Review deletion plan** with dependency-safe ordering
4. **Execute** with progress tracking

## Requirements

- VS Code 1.100.0 or later
- A Microsoft Dataverse environment (Power Platform / Dynamics 365)
- Azure AD account with read/write access to the target environment
- GitHub Copilot extension (optional — for AI-powered data and chat features)

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dvdata.environmentUrl` | `""` | Dataverse environment URL |
| `dvdata.authMethod` | `"browser"` | Authentication method |
| `dvdata.maxRecordsPerRun` | `5000` | Safety limit for total records per run |
| `dvdata.batchSize` | `100` | Operations per `$batch` request |

## Known Limitations

- Maximum 5,000 records per generation run (configurable)
- FetchXML cleanup queries limited to first page of results
- Some system columns are auto-excluded (state, status, auto-number, computed)

## License

MIT
