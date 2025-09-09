# 📋 TomoriBot Release System Documentation

This folder contains the **versioned release system** for TomoriBot deployments.

## 📁 Folder Structure

```
.github/release/
├── v{VERSION}/          # Version-specific assets (e.g., v0.7.0, v0.8.0)
│   ├── *.md            # Release notes (any filename ending in .md)
│   └── *.{png,jpg,etc} # Main image (any image format)
├── default/            # Fallback assets when version folder doesn't exist
│   ├── *.md           # Default release template
│   └── *.{png,jpg,etc} # Default image
└── README.md          # This documentation file
```

## 🤖 How It Works

### **Automatic Detection**
The GitHub Actions workflow automatically:

1. **Detects Version**: Reads version from `package.json` (e.g., "0.7.0")
2. **Checks for Folder**: Looks for `.github/release/v0.7.0/`
3. **Falls Back**: Uses `default/` folder if version-specific doesn't exist
4. **File Discovery**: 
   - **Release Notes**: First `.md` file found
   - **Main Image**: First image file found (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`)

### **Template Variables**
Any `.md` file can use these placeholders:

- `{VERSION}` → Package.json version (e.g., "0.7.0")
- `{TIMESTAMP}` → Deployment time ("2025-01-15 14:30:45 UTC")
- `{COMMIT_HASH}` → Git commit hash ("abc1234")
- `{REPO_OWNER}` → GitHub repository owner
- `{REPO_NAME}` → GitHub repository name

### **Discord Integration**
- **Main Image**: Displays as large embed image
- **Clean Text**: Markdown image syntax automatically stripped
- **Rich Embed**: Includes version, commit, release link, and deployment status

## 📝 Creating New Releases

### **For New Version (e.g., v0.8.0):**
1. Create folder: `.github/release/v0.8.0/`
2. Add release notes: `v0.8.0/my-notes.md` (any .md filename)
3. Add image: `v0.8.0/banner.png` (any image filename/format)
4. Update `package.json` version to "0.8.0"
5. Deploy to main branch

### **File Naming Flexibility:**
- ✅ `release-notes.md`, `changelog.md`, `info.md` - all work
- ✅ `banner.png`, `hero.jpg`, `preview.webp` - all work
- ✅ Different names per version - completely fine

## 🎯 Best Practices

### **Release Notes Content:**
- **What's New**: Features, improvements, bug fixes
- **Technical Details**: Architecture changes, performance metrics
- **Links**: Documentation, support, changelog
- **Credits**: Contributors and acknowledgments

### **Image Guidelines:**
- **Size**: 1200x600px recommended for optimal Discord display
- **Content**: TomoriBot branding, version number, key features
- **Format**: PNG preferred, but JPG/WebP work fine
- **Theme**: Match Discord dark/light mode compatibility

## 🚀 Examples

### **Minimal Release (v0.7.0):**
```
v0.7.0/
├── notes.md     # Simple release notes
└── image.png    # Single promotional image
```

### **Detailed Release (v0.8.0):**
```
v0.8.0/
├── comprehensive-changelog.md  # Detailed notes
└── hero-banner.jpg            # Professional banner
```

Both work identically - the system auto-detects the files!
