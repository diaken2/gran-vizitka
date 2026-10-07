import mongoose from 'mongoose'
import bcrypt from 'bcrypt'

const userSchema = new mongoose.Schema({
username: { type: String, required: true, unique: true },
passwordHash: { type: String, required: true },
role: { type: String, enum: ['viewer', 'limited', 'full'], default: 'viewer' },
}, { timestamps: true })

userSchema.methods.verifyPassword = function (password) {
return bcrypt.compare(password, this.passwordHash)
}

export default mongoose.model('User', userSchema)