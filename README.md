
# 🎓 MentorLagbe — Server

The backend API for MentorLagbe, a tuition and tutor-finding platform. It handles authentication, user roles, tuition management, student applications, subscription payments, and administrative operations.

## 🌐 Project Overview

MentorLagbe Server is built with Node.js, Express, TypeScript, and MongoDB. It provides RESTful APIs for the client application and integrates Better Auth for authentication and Stripe for subscription payments.

## ✨ Key Features

- **Authentication:** Better Auth integration with JWT support.
- **JWT Verification:** Secure token verification using JSON Web Keys (JWKS).
- **Role-Based Authorization:** Separate access permissions for Students, Tutors, and Admins.
- **Tuition Management:** Create, browse, update, and delete tuition listings.
- **Tuition Approval:** Admin approval system for submitted tuition posts.
- **Student Applications:** Submit applications and prevent duplicate applications.
- **Application Management:** Tutors can review applicants and update application statuses.
- **Bookmark Management:** API support for saved tuition listings.
- **Subscription Payments:** Stripe Checkout integration.
- **Payment Verification:** Verify completed Stripe Checkout sessions.
- **Stripe Webhooks:** Handle subscription lifecycle events.
- **Image Upload:** Image upload API integration.
- **Admin Management:** Manage users, tuition listings, and payment records.

## 🛠️ Technologies Used

| Technology | Purpose |
|---|---|
| Node.js | JavaScript runtime |
| Express.js | Backend framework |
| TypeScript | Type safety |
| MongoDB | Database |
| Better Auth | Authentication |
| JWT / JOSE | Token verification |
| Stripe | Subscription payments |
| dotenv | Environment configuration |
| CORS | Cross-origin resource sharing |

## 📁 Project Structure

```text
mentorlagbe-server/
├── src/
│   ├── config/
│   │   ├── auth.ts
│   │   ├── collections.ts
│   │   ├── db.ts
│   │   └── stripe.ts
│   ├── controllers/
│   ├── middlewares/
│   │   └── auth.middleware.ts
│   ├── routes/
│   │   ├── admin.routes.ts
│   │   ├── application.routes.ts
│   │   ├── bookmark.routes.ts
│   │   ├── payment.routes.ts
│   │   ├── tuition.routes.ts
│   │   ├── tutor.routes.ts
│   │   └── upload.routes.ts
│   ├── types/
│   │   └── tuition.types.ts
│   ├── utils/
│   └── server.ts
├── .env
├── .gitignore
├── package.json
└── README.md
```

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone YOUR_SERVER_REPOSITORY_URL
```

### 2. Navigate to the Project

```bash
cd mentorlagbe-server
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Create a `.env` file in the project root:

```env
PORT=5000

MONGODB_URI=your_mongodb_connection_string

BETTER_AUTH_URL=http://localhost:5000
BETTER_AUTH_SECRET=your_better_auth_secret

CLIENT_URL=http://localhost:3000

STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret

IMGBB_API_KEY=your_imgbb_api_key
```

**Important:** Never commit your `.env` file or expose secret keys in a public repository.

### 5. Run the Development Server

Use the development command configured in your `package.json`.

```bash
npm run dev
```

The backend API runs locally at:

[http://localhost:5000](http://localhost:5000)

## 🔐 Authentication & Authorization

The server uses Better Auth with JWT-based authentication.

Protected API routes verify JWT signatures through the Better Auth JWKS endpoint. Role-based middleware restricts access to specific resources.

Supported roles:

- **Student:** Browse tuition listings and apply for opportunities.
- **Tutor:** Create and manage tuition posts and review applicants.
- **Admin:** Manage users, tuition listings, and payment records.

## 💳 Stripe Integration

Stripe is used to manage subscription checkout and payment verification.

Subscription options:

- Student Plan — $10/month
- Tutor Plan — $15/month

The backend also processes Stripe webhook events to keep subscription information synchronized.

Use Stripe test credentials during development and testing.

## 🔗 Related Links

- **Live API:** Add your deployed backend URL here.
- **Frontend Repository:** Add your client GitHub repository URL here.

## 👩‍💻 Developer

**Halima Chowdhury Mahima**

Full Stack Web Developer

- GitHub: [halima-chowdhury-mahima](https://github.com/halima-chowdhury-mahima)

---

<p align="center">
  Built with ❤️ for MentorLagbe
</p>
