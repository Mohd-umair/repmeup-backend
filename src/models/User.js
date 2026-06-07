const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    // Password not required for OAuth users
    required: function() {
      return !this.oauth || !this.oauth.provider;
    },
    minlength: 6,
    select: false
  },
  oauth: {
    provider: {
      type: String,
      enum: ['google', 'facebook', 'linkedin', null]
    },
    providerId: String,
    accessToken: String,
    refreshToken: String,
    profile: mongoose.Schema.Types.Mixed
  },
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true
  },
  role: {
    type: String,
    enum: ['super_admin', 'admin', 'manager', 'agent', 'viewer'],
    default: 'agent'
  },
  permissions: [{
    type: String
  }],
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    default: null
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  assignedBuckets: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntentBucket'
  }],
  assignedPlatforms: [{
    type: String,
    enum: ['instagram', 'facebook', 'youtube', 'google', 'whatsapp', 'linkedin']
  }],
  avatar: String,
  isActive: {
    type: Boolean,
    default: true
  },
  /** Soft delete — user cannot sign in; hidden from default super-admin lists */
  deletedAt: {
    type: Date,
    default: null
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: String,
  /** When the pending verification link expires */
  emailVerificationExpires: Date,
  /** Throttle resend-verification emails */
  emailVerificationLastSent: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
  /** AES-encrypted password last set via super-admin (create/reset) — select: false */
  adminRecoverablePassword: { type: String, select: false },
  adminPasswordSetAt: { type: Date, select: false },
  adminPasswordSetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', select: false },

  // Email OTP login (6-digit, expires in 10 minutes)
  loginOtpCode: { type: String, select: false },
  loginOtpExpires: { type: Date, select: false },

  // Demo prospect magic-link login: SHA-256 hash of a one-time token the prospect
  // clicks to auto-login to their demo workspace (no password needed up front).
  demoMagicToken: { type: String, select: false },
  demoMagicTokenExpires: { type: Date, select: false },

  lastLogin: Date,
  preferences: {
    notifications: {
      type: Boolean,
      default: true
    },
    emailDigest: {
      type: Boolean,
      default: true
    },
    negativeSentimentAlerts: {
      type: Boolean,
      default: true
    },
    weeklyReports: {
      type: Boolean,
      default: false
    },
    emailFrequency: {
      type: String,
      enum: ['instant', 'daily', 'weekly'],
      default: 'daily'
    },
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light'
    },
    language: {
      type: String,
      default: 'en'
    },
    timezone: {
      type: String,
      default: 'UTC'
    }
  },
  metadata: {
    signupSource: String,
    signupIp: String,
    deviceInfo: String,
    /** True for the auto-created admin of a demo/trial workspace. */
    isDemoProspect: { type: Boolean, default: false }
  },
  risc: {
    googleSignInDisabled: {
      type: Boolean,
      default: false
    },
    accountDisabledReason: String,
    requiresCredentialChange: {
      type: Boolean,
      default: false
    },
    lastEvent: {
      type: {
        type: String
      },
      timestamp: Date,
      reason: String
    }
  }
}, {
  timestamps: true
});

// Indexes
// Note: email index is automatically created by unique: true
userSchema.index({ organization: 1, role: 1 });
userSchema.index({ deletedAt: 1 });

// Hash password before saving (skip for OAuth users without password)
userSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw new Error(error);
  }
};

// Get full name
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Remove sensitive data when converting to JSON
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  delete user.passwordResetToken;
  delete user.emailVerificationToken;
  delete user.emailVerificationExpires;
  delete user.emailVerificationLastSent;
  return user;
};

module.exports = mongoose.model('User', userSchema);

