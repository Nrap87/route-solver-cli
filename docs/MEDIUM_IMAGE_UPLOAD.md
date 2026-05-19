# Adding the leaderboard image on Medium

Medium **does not** load images from markdown like `![](images/file.png)`. Local paths only exist on your PC; the editor has no access to them. That is why upload “does not work” when you paste the whole `.md` file.

## Fix (recommended): add the image after pasting text

1. Save your leaderboard screenshot on disk (e.g. `galaxy-leaderboard.png` on Desktop).
2. In Medium, paste the article text **without** expecting images to appear.
3. Click the blank line under **“↓ Insert leaderboard image here…”**
4. Add the image using **one** of these methods:

### Method A — Drag and drop (most reliable)

- Drag the `.png` file from File Explorer onto the Medium story.
- Wait until the upload progress finishes (spinner on the image).

### Method B — Toolbar

- Click the **`+`** (or picture icon) in the left margin of the editor.
- Choose **Image** → upload from computer.

### Method C — Paste from clipboard

- Open the screenshot (Photos, Snipping Tool, etc.).
- Copy the image (`Ctrl+C`).
- Click in Medium where the image should go → `Ctrl+V`.

5. Delete the line **“↓ Insert leaderboard image here…”** after the image is in place.
6. Click the uploaded image → **Alt text** (optional):  
   `Galaxy Leaderboard final standings — Nelson Pinto 4th, María 3rd`
7. Leave the *Figure:* italic line as the caption, or merge it into Medium’s caption field.

## If upload still fails

| Symptom | Try this |
|--------|-----------|
| Nothing happens on paste | Use **Chrome or Edge**; disable ad blockers for `medium.com`. |
| Spinner never completes | Smaller file: export PNG &lt; 5 MB; avoid 4K screenshots. |
| “Upload failed” | Rename file (no special characters); use `.png` or `.jpg`. |
| Image in wrong place | Medium splits pasted HTML oddly — add image **after** text is pasted, not before. |
| Broken `![](...)` text visible | Remove those lines; they are not valid on Medium. |

## Do not use for this article

- **Markdown image syntax** in the pasted body (`![](...)`).
- **Import from URL** unless the image is already hosted on a public HTTPS URL.
- Pasting the `.md` file into Medium from VS Code preview expecting images to carry over.

## Optional: host image on GitHub

If drag-and-drop keeps failing:

1. Put `galaxy-leaderboard-final.png` in `docs/images/` in your repo and push.
2. Open the file on GitHub → **Raw** → copy URL.
3. In Medium: `+` → image from URL (if your account shows that option), or use [medium.com/p/import](https://medium.com/p/import) only for full posts, not single images.

For a single screenshot, **drag-and-drop after pasting text** remains the simplest approach.
