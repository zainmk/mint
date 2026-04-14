# mint🙓
web app to track credit card statement activity

### purpose
Financial institutions do not expose APIs for users to access their own financial transaction data, however exportable .csv's are offered af the end of every statement. This application can make use of those exportable csv's (Date, Title, Amount), allow the user to 'tag' them, and output display the data through differnet 'perspectives' of your spending habits.

### stack
**ReactJS - IndexedDB - Vercel**

It was also a goal to have the stack for this project be entirely frontend, in your browser. The app's functionality is based on a very simple schema design, therefore the data can be held entirely locally, either via .csv files the user can export/move the 'state' of the app around, or the indexedDB keeping state persistent in browser.

### setup
To setup, just need to navigate to the public URL. You just need to keep providing the .csv's (w. 'Date', 'Amount' and 'Title' columns) representing your financial transactions.


### ex.

https://github.com/user-attachments/assets/e74b602b-c879-4f2a-ba84-bc279eddbb9b






