const express = require("express");
const csrf = require("csurf");
const stripe = require("stripe")(process.env.STRIPE_PRIVATE_KEY);
const Product = require("../models/product");
const Category = require("../models/category");
const Cart = require("../models/cart");
const Order = require("../models/order");
const middleware = require("../middleware");
const router = express.Router();
var nodemailer = require('nodemailer');
const csrfProtection = csrf();
router.use(csrfProtection);

// GET: home page
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({})
      .sort("-createdAt")
      .populate("category");
    res.render("shop/home", { pageName: "Home", products });
  } catch (error) {
    console.log(error);
    res.redirect("/");
  }
});

// GET: add a product to the shopping cart when "Add to cart" button is pressed
router.get("/add-to-cart/:id", async (req, res) => {
  const productId = req.params.id;
  try {
    // get the correct cart, either from the db, session, or an empty cart.
    let user_cart;
    if (req.user) {
      user_cart = await Cart.findOne({ user: req.user._id });
    }
    let cart;
    if (
      (req.user && !user_cart && req.session.cart) ||
      (!req.user && req.session.cart)
    ) {
      cart = await new Cart(req.session.cart);
    } else if (!req.user || !user_cart) {
      cart = new Cart({});
    } else {
      cart = user_cart;
    }

    // add the product to the cart
    const product = await Product.findById(productId);
    const itemIndex = cart.items.findIndex((p) => p.productId == productId);
    if (itemIndex > -1) {
      // if product exists in the cart, update the quantity
      cart.items[itemIndex].qty++;
      cart.items[itemIndex].price = cart.items[itemIndex].qty * product.price;
      cart.totalQty++;
      cart.totalCost += product.price;
    } else {
      // if product does not exists in cart, find it in the db to retrieve its price and add new item
      cart.items.push({
        productId: productId,
        qty: 1,
        price: product.price,
        title: product.title,
        productCode: product.productCode,
      });
      cart.totalQty++;
      cart.totalCost += product.price;
    }

    // if the user is logged in, store the user's id and save cart to the db
    if (req.user) {
      cart.user = req.user._id;
      await cart.save();
    }
    req.session.cart = cart;
    req.flash("success", "Item added to the shopping cart");
    res.redirect(req.headers.referer);
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: view shopping cart contents
router.get("/shopping-cart", async (req, res) => {
  try {
    // find the cart, whether in session or in db based on the user state
    let cart_user;
    if (req.user) {
      cart_user = await Cart.findOne({ user: req.user._id });
    }
    // if user is signed in and has cart, load user's cart from the db
    if (req.user && cart_user) {
      req.session.cart = cart_user;
      return res.render("shop/shopping-cart", {
        cart: cart_user,
        pageName: "Shopping Cart",
        products: await productsFromCart(cart_user),
      });
    }
    // if there is no cart in session and user is not logged in, cart is empty
    if (!req.session.cart) {
      return res.render("shop/shopping-cart", {
        cart: null,
        pageName: "Shopping Cart",
        products: null,
      });
    }
    // otherwise, load the session's cart
    return res.render("shop/shopping-cart", {
      cart: req.session.cart,
      pageName: "Shopping Cart",
      products: await productsFromCart(req.session.cart),
    });
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: reduce one from an item in the shopping cart
router.get("/reduce/:id", async function (req, res, next) {
  // if a user is logged in, reduce from the user's cart and save
  // else reduce from the session's cart
  const productId = req.params.id;
  let cart;
  try {
    if (req.user) {
      cart = await Cart.findOne({ user: req.user._id });
    } else if (req.session.cart) {
      cart = await new Cart(req.session.cart);
    }

    // find the item with productId
    let itemIndex = cart.items.findIndex((p) => p.productId == productId);
    if (itemIndex > -1) {
      // find the product to find its price
      const product = await Product.findById(productId);
      // if product is found, reduce its qty
      cart.items[itemIndex].qty--;
      cart.items[itemIndex].price -= product.price;
      cart.totalQty--;
      cart.totalCost -= product.price;
      // if the item's qty reaches 0, remove it from the cart
      if (cart.items[itemIndex].qty <= 0) {
        await cart.items.remove({ _id: cart.items[itemIndex]._id });
      }
      req.session.cart = cart;
      //save the cart it only if user is logged in
      if (req.user) {
        await cart.save();
      }
      //delete cart if qty is 0
      if (cart.totalQty <= 0) {
        req.session.cart = null;
        await Cart.findByIdAndRemove(cart._id);
      }
    }
    res.redirect(req.headers.referer);
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: remove all instances of a single product from the cart
router.get("/removeAll/:id", async function (req, res, next) {
  const productId = req.params.id;
  let cart;
  try {
    if (req.user) {
      cart = await Cart.findOne({ user: req.user._id });
    } else if (req.session.cart) {
      cart = await new Cart(req.session.cart);
    }
    //fnd the item with productId
    let itemIndex = cart.items.findIndex((p) => p.productId == productId);
    if (itemIndex > -1) {
      //find the product to find its price
      cart.totalQty -= cart.items[itemIndex].qty;
      cart.totalCost -= cart.items[itemIndex].price;
      await cart.items.remove({ _id: cart.items[itemIndex]._id });
    }
    req.session.cart = cart;
    //save the cart it only if user is logged in
    if (req.user) {
      await cart.save();
    }
    //delete cart if qty is 0
    if (cart.totalQty <= 0) {
      req.session.cart = null;
      await Cart.findByIdAndRemove(cart._id);
    }
    res.redirect(req.headers.referer);
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: checkout form with csrf token
router.get("/checkout", middleware.isLoggedIn, async (req, res) => {
  const errorMsg = req.flash("error")[0];

  if (!req.session.cart) {
    return res.redirect("/shopping-cart");
  }
  //load the cart with the session's cart's id from the db
  cart = await Cart.findById(req.session.cart._id);

  const errMsg = req.flash("error")[0];
  res.render("shop/checkout", {
    total: cart.totalCost,
    csrfToken: req.csrfToken(),
    errorMsg,
    pageName: "Checkout",
  });
});

//failur
router.post("/failer", function (req, res)  {

  console.log("payment fail zalai audumber");
  return res.redirect("/checkout");
  
  });




  var transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'education4ol4@gmail.com',
      pass: 'Audumber@3000'
    }
  });
  



//success
  router.post("/success", middleware.isLoggedIn, async (req, res) => {

    if (!req.session.cart) {
      return res.redirect("/shopping-cart");
    }
    const cart = await Cart.findById(req.session.cart._id);


    console.log("payment success ful ");


    var mailrejected = {
      from: 'education4ol4@gmail.com',
      to: req.body.mail,
      subject: 'Thankyou for shopping with Us.',
      text: 'Hi ' +req.body.name   +'\n  You made our day, thank you for choosing us for your purchase. We are happy to meet your purchase order and value our loyal customers. \n\n We would like to inform you that your payment has been recived and Order No.' + req.session.cart._id + '\n\n Thank you for shopping with us. Keep Shopping with us. \n\n Company Name  \n Company Details : www.company.com \n Company Linkdin : https://www.linkedin.com/company/  '
    };


    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        console.log(error);
        const order = new Order({
          user: req.user,
          cart: {
            totalQty: cart.totalQty,
            totalCost: cart.totalCost,
            items: cart.items,
          },
          
          paymentId: req.body.payment_id,
          
          name : req.body.name,
          address: req.body.address,
          city : req.body.city,
          state : req.body.state,
          zip : req.body.zip,
          contact : req.body.contact,
          mail : req.body.mail
    
        });
        order.save(async (err, newOrder) => {
          if (err) {
            console.log(err);
            return res.redirect("/checkout");
          }
          await cart.save();
          await Cart.findByIdAndDelete(cart._id);
          req.flash("success", "Successfully purchased");
          req.session.cart = null;
          res.redirect("/user/profile");
        });
    
      }//if mail is right
       else {
        console.log('Email sent: ' + info.response);
        const order = new Order({
          user: req.user,
          cart: {
            totalQty: cart.totalQty,
            totalCost: cart.totalCost,
            items: cart.items,
          },
          
          paymentId: req.body.payment_id,
          
          name : req.body.name,
          address: req.body.address,
          city : req.body.city,
          state : req.body.state,
          zip : req.body.zip,
          contact : req.body.contact,
          mail : req.body.mail
    
        });
        order.save(async (err, newOrder) => {
          if (err) {
            console.log(err);
            return res.redirect("/checkout");
          }
          await cart.save();
          await Cart.findByIdAndDelete(cart._id);
          req.flash("success", "Successfully purchased");
          req.session.cart = null;
          res.redirect("/user/profile");
        });
    
      }

    });






   
    
    
    });


// POST: handle checkout logic and payment using Stripe
router.post("/checkout", middleware.isLoggedIn, async (req, res) => {
  if (!req.session.cart) {
    return res.redirect("/shopping-cart");
  }
  const cart = await Cart.findById(req.session.cart._id);
  console.log("PAYMENT CHECK OUT DONE !")
  console.log(cart.totalCost);

 console.log(req.body.name);
 console.log(req.body.address);
 console.log(req.body.state);
 console.log(req.body.city);
 console.log(req.body.zip);
 console.log(req.body.contact);
 console.log(req.body.email);


  res.render("shop/razopay", {
    total: cart.totalCost * 100,
    name :  req.body.name,
    address : req.body.address,
    state : req.body.state,
    city : req.body.city,
    zip  : req.body.zip,
    contact : req.body.contact,
    email : req.body.email,

    csrfToken: req.csrfToken(),
   
    pageName: "checkout1",
    cart : cart
  });

//razorpay payment

var instance = new Razorpay({ key_id: 'rzp_live_eZdWnBRmYRCLWo', key_secret: 'YOUR_SECRET' })

var options = {
  amount: 50000,  // amount in the smallest currency unit
  currency: "INR",
  receipt: "order_rcptid_11"
};
instance.orders.create(options, function(err, order) {
  console.log(order);
});















  //stripe payment gateway
  stripe.charges.create(
    {
      amount: cart.totalCost * 100,
      currency: "usd",
      source: req.body.stripeToken,
      description: "Test charge",
    },
    function (err, charge) {
      if (err) {
        req.flash("error", err.message);
        console.log(err);
        return res.redirect("/checkout");
      }
      const order = new Order({
        user: req.user,
        cart: {
          totalQty: cart.totalQty,
          totalCost: cart.totalCost,
          items: cart.items,
        },
        address: req.body.address,
        paymentId: charge.id,
      });
      order.save(async (err, newOrder) => {
        if (err) {
          console.log(err);
          return res.redirect("/checkout");
        }
        await cart.save();
        await Cart.findByIdAndDelete(cart._id);
        req.flash("success", "Successfully purchased");
        req.session.cart = null;
        res.redirect("/user/profile");
      });
    }
  );
});

// create products array to store the info of each product in the cart
async function productsFromCart(cart) {
  let products = []; // array of objects
  for (const item of cart.items) {
    let foundProduct = (
      await Product.findById(item.productId).populate("category")
    ).toObject();
    foundProduct["qty"] = item.qty;
    foundProduct["totalPrice"] = item.price;
    products.push(foundProduct);
  }
  return products;
}

module.exports = router;
