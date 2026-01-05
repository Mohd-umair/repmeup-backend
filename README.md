# ORM System - Backend API

Node.js + Express REST API for the ORM (Online Reputation Management) System.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment Variables
```bash
cp env-example.txt .env
# Edit .env with your actual values
```

### 3. Start MongoDB and Redis
```bash
# Using Docker Compose (recommended)
cd ..
docker-compose up -d

# Or install locally
# MongoDB: https://www.mongodb.com/try/download/community
# Redis: https://redis.io/download
```

### 4. Run Development Server
```bash
npm run dev
```

Server will start on `http://localhost:3000`

## 📝 Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint errors
- `npm run format` - Format code with Prettier

## 🗂️ Project Structure

```
backend/
├── src/
│   ├── config/
│   │   ├── database.js       # MongoDB connection
│   │   ├── redis.js          # Redis client
│   │   └── queue.js          # Bull queue config
│   ├── models/
│   │   ├── User.js           # User schema
│   │   ├── Organization.js   # Organization schema
│   │   ├── Interaction.js    # Main interaction schema
│   │   ├── PlatformConnection.js
│   │   ├── Label.js
│   │   ├── KnowledgeBase.js
│   │   ├── ResponseTemplate.js
│   │   └── Notification.js
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── inboxController.js
│   │   └── ...
│   ├── services/
│   │   ├── authService.js    # Auth business logic
│   │   ├── aiService.js      # OpenAI integration
│   │   ├── cacheService.js   # Redis caching
│   │   └── emailService.js   # Email sending
│   ├── middlewares/
│   │   ├── auth.js           # JWT authentication
│   │   ├── validation.js     # Input validation
│   │   └── errorHandler.js   # Error handling
│   ├── routes/
│   │   ├── auth.js
│   │   ├── inbox.js
│   │   └── ...
│   ├── integrations/
│   │   ├── meta/             # Instagram, Facebook, WhatsApp
│   │   ├── google/           # YouTube, Google Reviews
│   │   └── ...
│   ├── jobs/
│   │   ├── processWebhook.js
│   │   ├── syncPlatform.js
│   │   ├── processAI.js
│   │   └── sendNotification.js
│   ├── utils/
│   ├── app.js                # Express app setup
│   └── server.js             # Server entry point
├── tests/
├── package.json
└── README.md
```

## 🔌 API Endpoints

### Authentication (`/api/auth`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/register` | Register user & organization | No |
| POST | `/login` | Login user | No |
| GET | `/me` | Get current user | Yes |
| PUT | `/profile` | Update profile | Yes |
| PUT | `/change-password` | Change password | Yes |
| POST | `/logout` | Logout user | Yes |
| POST | `/team-member` | Create team member | Yes (Admin/Manager) |

### Inbox (`/api/inbox`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/` | Get all interactions | Yes |
| GET | `/:id` | Get single interaction | Yes |
| POST | `/:id/reply` | Reply to interaction | Yes |
| PUT | `/:id/assign` | Assign to agent | Yes (Manager/Admin) |
| PUT | `/:id/labels` | Add label | Yes |
| POST | `/:id/notes` | Add internal note | Yes |
| PUT | `/:id/status` | Update status | Yes |
| GET | `/stats` | Get inbox statistics | Yes |

## 🔐 Environment Variables

### Required Variables
```bash
# Server
NODE_ENV=development
PORT=3000

# Database
MONGODB_URI=mongodb://localhost:27017/orm_development
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-secret-key-minimum-32-characters
JWT_EXPIRE=7d
```

### Platform API Keys
```bash
# Meta (Instagram, Facebook, WhatsApp)
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
META_REDIRECT_URI=http://localhost:3000/api/platforms/meta/callback
META_VERIFY_TOKEN=your_webhook_verify_token

# WhatsApp Business API
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_access_token

# Google (YouTube, Google Reviews)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret

# OpenAI
OPENAI_API_KEY=your_openai_api_key
```

## 🗄️ Database Models

### Core Models
1. **User** - User accounts with roles
2. **Organization** - Multi-tenant organizations
3. **Interaction** - Comments, DMs, reviews (main model)
4. **PlatformConnection** - OAuth tokens for platforms
5. **Label** - Custom labels for categorization
6. **KnowledgeBase** - AI training data
7. **ResponseTemplate** - Quick reply templates
8. **Notification** - User notifications

## 🔄 Queue Jobs

Uses Bull (Redis-based) for background processing:

1. **Webhook Processing** - Handle incoming webhooks
2. **Platform Sync** - Periodic sync from platforms
3. **AI Processing** - Sentiment analysis & response generation
4. **Notifications** - Send email notifications

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm test -- --coverage
```

## 🐛 Debugging

### Enable Debug Logs
```bash
LOG_LEVEL=debug npm run dev
```

### Check Health
```bash
curl http://localhost:3000/health
```

### Test MongoDB Connection
```bash
# In MongoDB Compass, connect to:
mongodb://admin:password@localhost:27017
```

### Test Redis Connection
```bash
redis-cli
> PING
PONG
```

## 📊 Performance

- Implements Redis caching for frequently accessed data
- Uses MongoDB indexes for faster queries
- Rate limiting to prevent abuse
- Background job processing for heavy tasks

## 🔒 Security

- JWT-based authentication
- Password hashing with bcrypt
- Helmet.js for security headers
- Rate limiting
- Input validation with Joi
- CORS protection

## 🚀 Deployment

### Production Checklist
- [ ] Set `NODE_ENV=production`
- [ ] Use strong `JWT_SECRET`
- [ ] Configure MongoDB Atlas or production MongoDB
- [ ] Configure Redis Cloud or production Redis
- [ ] Set up proper CORS origins
- [ ] Enable SSL/TLS
- [ ] Set up monitoring (DataDog, New Relic)
- [ ] Configure error tracking (Sentry)
- [ ] Set up automated backups

### Docker Deployment
```bash
# Build image
docker build -t orm-backend .

# Run container
docker run -p 3000:3000 --env-file .env orm-backend
```

## 📚 Additional Resources

- [Express.js Documentation](https://expressjs.com/)
- [Mongoose Documentation](https://mongoosejs.com/)
- [Bull Queue Documentation](https://github.com/OptimalBits/bull)
- [OpenAI API Documentation](https://platform.openai.com/docs)

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Run tests and linting
4. Submit a pull request

## 📝 License

Proprietary - All rights reserved

