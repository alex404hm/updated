require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const compression = require('compression');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const csrf = require('csurf');
const logger = require('./utils/logger');
const config = require('./config/config');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const statsRoutes = require('./routes/statsRoutes');
const { errorHandler } = require('./middlewares/errorMiddleware');

// Initialize Express app
const app = express();

// Global Promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
});

// MongoDB connection with retry
const connectToMongoDB = async (retryCount = 0) => {
    const MAX_RETRIES = 5;
    try {
        await mongoose.connect(config.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        logger.info('MongoDB connected successfully.');
    } catch (error) {
        logger.error(`MongoDB connection error: ${error.message}`);
        if (retryCount < MAX_RETRIES) {
            logger.warn(`Retrying MongoDB connection (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => connectToMongoDB(retryCount + 1), 5000);
        } else {
            logger.error('Max retries reached. Exiting...');
            process.exit(1);
        }
    }
};
connectToMongoDB();

// Security middlewares
app.use(
    helmet({
        contentSecurityPolicy: config.isProduction ? undefined : false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
);

// Essential middlewares
app.use(express.json({ limit: '10kb' })); // Limit payload size
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(compression()); // Enable Gzip compression

// CORS configuration
app.use(
    cors({
        origin: config.FRONTEND_URL,
        credentials: true,
        allowedHeaders: ['X-CSRF-TOKEN', 'Content-Type', 'Authorization'],
    })
);

// Session management
app.use(
    session({
        secret: config.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: config.isProduction,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // 1 day
        },
    })
);

// CSRF protection
const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);

// Set CSRF token for frontend
app.use((req, res, next) => {
    res.cookie('XSRF-TOKEN', req.csrfToken(), { secure: config.isProduction, httpOnly: false });
    next();
});

// Serve static files with caching for performance
app.use(express.static(path.join(__dirname, '../web'), { maxAge: '30d' }));

// Utility to serve HTML files
const serveHtmlPage = (directory) => (req, res) => {
    const fileName = `${req.params.page || 'index'}.html`;
    const filePath = path.join(directory, fileName);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Page not found');
    }
};

// Dynamically serve all HTML files in the "tools" folder
const toolsPath = path.join(__dirname, '../web/html/dashboard/tools');
fs.readdir(toolsPath, (err, files) => {
    if (err) {
        logger.error(`Error reading tools directory: ${err.message}`);
    } else {
        files.forEach((file) => {
            const fileName = path.parse(file).name;
            app.get(`/dashboard/tools/${fileName}`, (req, res) => {
                res.sendFile(path.join(toolsPath, file));
            });
        });
    }
});

// Dynamic HTML routes for other sections
const htmlDirectory = path.join(__dirname, '../web/html');
const staticPages = ['/', '/auth/:page?', '/dashboard', '/shop', '/faq-support', '/forum', '/tools', '/claim', '/settings'];
staticPages.forEach((route) => {
    app.get(route, serveHtmlPage(htmlDirectory));
});

// API routes
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/stats', statsRoutes);

// Error handling middleware
app.use(errorHandler);

// Start the server
const server = app.listen(config.PORT, () => {
    logger.info(`Server running on port ${config.PORT}`);
});

// Graceful shutdown function
const gracefulShutdown = async () => {
    try {
        logger.info('Gracefully shutting down the server...');
        await mongoose.connection.close();
        logger.info('MongoDB connection closed.');
        server.close(() => {
            logger.info('Server shut down successfully.');
            process.exit(0);
        });
    } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
    }
};

// Handle termination signals
['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, gracefulShutdown));