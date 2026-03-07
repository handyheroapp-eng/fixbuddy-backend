# FixBuddy Backend

Clean, production-ready backend API for the FixBuddy React Native Expo app.

## Features

- AI-powered home repair diagnosis using OpenAI GPT-4o-mini
- Structured JSON responses with safety warnings and repair guides
- CORS enabled for all origins
- Health check endpoint

## Prerequisites

- Node.js (v16 or higher)
- OpenAI API key

## Installation

```bash
cd backend
npm install
```

## Configuration

1. Create a `.env` file in the `backend` directory:

```bash
cp .env.example .env
```

2. Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-actual-key-here
```

## Running the Server

```bash
npm start
```

The server will start on `http://localhost:3000`

## API Endpoints

### Health Check

**GET** `/health`

Returns server status.

**Response:**
```json
{
  "ok": true
}
```

### Diagnose Home Repair Issue

**POST** `/diagnose`

Analyzes a home repair problem and returns structured diagnosis.

**Request Body:**
```json
{
  "issueText": "My kitchen sink is leaking under the cabinet and there's water pooling"
}
```

**Response:**
```json
{
  "problem_summary": "Kitchen sink leak under cabinet with water accumulation",
  "safety_level": "MEDIUM",
  "safety_warnings": [
    "Turn off water supply before inspection",
    "Check for electrical outlets near water source"
  ],
  "clarifying_questions": [
    "Is the leak constant or only when water is running?",
    "Do you see any rust or corrosion on pipes?"
  ],
  "likely_causes": [
    "Loose P-trap connection",
    "Worn out washer or gasket",
    "Corroded pipes"
  ],
  "fix_guides": [
    {
      "title": "Tighten P-trap connections",
      "difficulty": "EASY",
      "steps": [
        "Turn off water supply",
        "Place bucket under P-trap",
        "Hand-tighten slip nuts on P-trap"
      ]
    }
  ],
  "maintenance_tips": [
    "Check under-sink connections monthly",
    "Keep area dry to prevent mold"
  ]
}
```

**Error Response (Invalid JSON from OpenAI):**
```json
{
  "error": "Invalid JSON returned from OpenAI",
  "raw": "...raw response text..."
}
```

## Testing the API

### Using curl:

```bash
# Health check
curl http://localhost:3000/health

# Diagnose issue
curl -X POST http://localhost:3000/diagnose \
  -H "Content-Type: application/json" \
  -d '{"issueText": "My toilet keeps running after flushing"}'
```

### Using Postman or Insomnia:

1. Set method to **POST**
2. URL: `http://localhost:3000/diagnose`
3. Headers: `Content-Type: application/json`
4. Body (raw JSON):
```json
{
  "issueText": "My furnace is making a loud banging noise"
}
```

## Production Deployment

### Environment Variables

Set the following in your production environment:
- `OPENAI_API_KEY` - Your OpenAI API key

### Recommended Hosting

- **Railway**: One-click deploy with automatic HTTPS
- **Render**: Free tier available
- **Heroku**: Easy deployment with add-ons
- **DigitalOcean App Platform**: Scalable and reliable

### Security Recommendations

1. **Rate Limiting**: Add rate limiting to prevent abuse
   ```bash
   npm install express-rate-limit
   ```

2. **API Key Validation**: Add middleware to validate requests
3. **HTTPS Only**: Ensure production uses HTTPS
4. **Environment Secrets**: Never commit `.env` to version control

## Connecting to React Native

In your React Native Expo app:

```javascript
const diagnoseIssue = async (issueText) => {
  try {
    const response = await fetch('http://localhost:3000/diagnose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ issueText }),
    });
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Diagnosis error:', error);
    throw error;
  }
};
```

**Note:** Replace `localhost:3000` with your production URL when deploying.

## Project Structure

```
backend/
├── server.js           # Main Express server
├── package.json        # Dependencies
├── .env               # Environment variables (not in git)
├── .env.example       # Example env file
└── README.md          # This file
```

## Troubleshooting

### Port already in use
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

### OpenAI API errors
- Verify API key is correct in `.env`
- Check OpenAI account has credits
- Ensure internet connection is working

### CORS errors in React Native
- Make sure CORS is enabled (already configured)
- Check that you're using the correct backend URL

## License

MIT
