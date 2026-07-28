# RABG: Add Beaten Badges to RetroAchievements
Shows your beaten games alongside mastered games in the Game Awards section of RetroAchievements profile pages.

[<img src="https://blog.mozilla.org/addons/files/2015/11/get-the-addon.png">](https://addons.mozilla.org/en-US/firefox/addon/rabg-for-retroachievements/) [<img src="https://developer.chrome.com/static/docs/webstore/branding/image/206x58-chrome-web-bcb82d15b2486.png">](https://chromewebstore.google.com/detail/bpejbgdgfhgcnddgbheipnondimncjfk/)

***

# How It Works?

On a RetroAchievements user profile page, this extension:
1. Reads the "Completion Progress" list for every game marked as "beaten".
2. Sorts them by completion percentage (highest first).
3. Adds them to the "Game Awards" grid with a silver frame.
4. Adds a second counter with a silver crown icon for beaten games.

<img src="https://raw.githubusercontent.com/sakci/rabg/main/compare.png" width="512">

At the very bottom of the page (i.e. the footer section of the website), there'll be a settings section that lets you adjust the way the beaten badges are sorted.

<img src="https://raw.githubusercontent.com/sakci/rabg/main/footer.png" width="512">

***

# Changelog

You can find the changelog [here](CHANGELOG.md).

***

# What's missing? / Future plans
- If a user has beaten hundreds of games, the extension may not be able create badge for every single one of them. The extension can only generate badges for games listed in the Completion Progress section (this section only displays games with the highest completion percentages). I’ve heard that RA will soon introduce OAuth support; if OAuth support is added, it may be possible to generate badges for all completed games.
- Currently, it is not possible to sort badges by “Beaten Date” because there isn’t a reliable way for this extension to determine the exact date games were beaten. If OAuth support is introduced to RA, it may become possible to add this feature based on the information we can access via OAuth.
- Manually sorting badges, hiding specific badges, and making sure all these features work properly across all browsers and on mobile devices doesn’t seem like a very simple task. Not to mention, since the current version of the extension can’t access a list of all the games users have beaten, it might not make sense to add this feature right now.
